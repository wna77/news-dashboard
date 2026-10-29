// 내 관심종목 시세 (국내 주식)
// 사용법: /api/quote?codes=005930,000660
//
// 1순위: 네이버가 자기 웹페이지에서 쓰는 실시간 JSON (polling.finance.naver.com)
//        → 지수 카드에서 이미 잘 쓰고 있는 것과 같은 서버라 거의 실시간이에요.
// 2순위: 네이버 모바일 증권 JSON (m.stock.naver.com/api/stock/{code}/basic)
//
// 응답 필드 이름은 실제 호출 전엔 100% 확신할 수 없어서, 후보 이름을 여러 개
// 시도하는 방식(pick)으로 방어적으로 짰어요.
// (미국 주식은 2차 작업에서 market=us 로 추가할 예정)

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const DOWN_CODES = new Set(["3", "4", "5", "FALLING", "LOWER_LIMIT", "down", "DOWN"]);
const UP_CODES = new Set(["1", "2", "RISING", "UPPER_LIMIT", "up", "UP"]);
const MAX_CODES = 40;

function toFloat(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/,/g, "").replace(/%/g, ""));
  return isNaN(n) ? null : n;
}

function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function normalize(d, code) {
  if (!d || typeof d !== "object") return null;

  const price = toFloat(pick(d, ["closePriceRaw", "closePrice", "nowPrice", "currentPrice", "price"]));
  if (price === null) return null;

  let change = toFloat(
    pick(d, ["compareToPreviousClosePriceRaw", "compareToPreviousClosePrice", "changePrice", "change"])
  );
  let changePercent = toFloat(pick(d, ["fluctuationsRatioRaw", "fluctuationsRatio", "changeRate", "fluctuationRate"]));

  const dirObj = d.compareToPreviousPrice;
  const dirCode = dirObj && typeof dirObj === "object" ? dirObj.code || dirObj.name : dirObj;

  let direction = "flat";
  if (dirCode !== undefined && dirCode !== null && DOWN_CODES.has(String(dirCode))) direction = "down";
  else if (dirCode !== undefined && dirCode !== null && UP_CODES.has(String(dirCode))) direction = "up";
  else if (change) direction = change > 0 ? "up" : "down";
  else if (changePercent) direction = changePercent > 0 ? "up" : "down";

  const sign = direction === "down" ? -1 : direction === "up" ? 1 : 0;
  change = change === null ? 0 : Math.abs(change) * sign;
  changePercent = changePercent === null ? 0 : Math.abs(changePercent) * sign;

  return {
    code: String(pick(d, ["itemCode", "stockCode", "code"]) || code),
    name: String(pick(d, ["stockName", "itemName", "name"]) || ""),
    price,
    change,
    changePercent,
    direction,
    marketStatus: pick(d, ["marketStatus"]) || null,
    tradedAt: pick(d, ["localTradedAt", "tradedAt"]) || null,
  };
}

async function fromPolling(code) {
  const json = await fetchJson(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`);
  const d = json?.datas?.[0] || json?.data?.[0] || json?.result?.[0];
  const item = normalize(d, code);
  if (!item) throw new Error("실시간 데이터 없음");
  return { ...item, source: "naver-realtime" };
}

async function fromMobile(code) {
  const json = await fetchJson(`https://m.stock.naver.com/api/stock/${code}/basic`);
  const item = normalize(json?.datas?.[0] || json?.result || json, code);
  if (!item) throw new Error("모바일 데이터 없음");
  return { ...item, source: "naver-mobile" };
}

async function fetchOne(code) {
  try {
    return await fromPolling(code);
  } catch (e1) {
    try {
      return await fromMobile(code);
    } catch (e2) {
      throw new Error(`${e1.message} / ${e2.message}`);
    }
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const codes = String(req.query.codes || "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[0-9A-Z]{6}$/.test(c))
    .slice(0, MAX_CODES);

  if (!codes.length) {
    res.status(200).json({ items: [], errors: [], fetchedAt: new Date().toISOString() });
    return;
  }

  const items = [];
  const errors = [];

  await Promise.all(
    codes.map(async (code) => {
      try {
        items.push(await fetchOne(code));
      } catch (err) {
        errors.push(`${code}: ${err.message}`);
      }
    })
  );

  res.status(200).json({ items, errors, fetchedAt: new Date().toISOString() });
};

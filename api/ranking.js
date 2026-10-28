// 네이버 증권이 자기 웹/앱(stock.naver.com)에서 쓰는 공개 JSON API를 그대로 가져와요.
// (로그인/키 불필요) 예전엔 오래된 HTML 랭킹 페이지를 긁어왔는데, 그중 "거래량상위"
// 주소가 틀려서(404) 아예 더 안정적인 최신 JSON API로 바꿨어요.
// 이 API는 marketType=ALL로 코스피+코스닥을 한 번에 랭킹으로 받아올 수 있어요.
//
// 응답의 정확한 필드 이름은 실제로 호출해보기 전엔 100% 확신할 수 없어서,
// 흔히 쓰이는 후보 이름들을 여러 개 시도하는 방식으로 짰어요 (findItemsArray/pick).
// 그래도 혹시 안 맞으면 바로 고칠 수 있게 구조를 단순하게 유지했어요.

const BASE = "https://stock.naver.com/api/domestic/market/stock/default";
const SEARCH_TOP_URL =
  "https://stock.naver.com/api/domestic/market/searchTop?nationType=KOR&startIdx=0&pageSize=10";

const ORDER_TYPE = {
  quant: "priceTop", // 거래대금상위
  rise: "up", // 상승
  fall: "down", // 하락
  marketcap: "marketSum", // 시가총액
  volume: "quantTop", // 거래량상위
};

const LABELS = {
  quant: "거래대금상위",
  rise: "상승",
  fall: "하락",
  marketcap: "시가총액",
  volume: "거래량상위",
  popular: "인기종목",
};

const DOWN_CODES = new Set(["3", "4", "5", "down", "DOWN"]);
const UP_CODES = new Set(["1", "2", "up", "UP"]);

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

// 응답 어딘가에 있을 "종목 배열"을 재귀적으로 찾음 (정확한 래핑 구조를 몰라도 되도록)
function findItemsArray(obj, depth) {
  depth = depth || 0;
  if (depth > 6 || obj === null || obj === undefined) return null;

  if (Array.isArray(obj)) {
    if (obj.length && obj[0] && typeof obj[0] === "object") {
      const sample = obj[0];
      const hasCode = pick(sample, ["itemCode", "stockCode", "code", "symbolCode", "itemcode", "cd"]) !== undefined;
      const hasPrice =
        pick(sample, ["closePrice", "nowPrice", "price", "closePriceRaw", "stockEndPrice"]) !== undefined;
      const hasName = pick(sample, ["stockName", "itemName", "name", "itemname", "nm"]) !== undefined;
      if (hasCode || (hasPrice && hasName)) return obj;
    }
    for (const el of obj) {
      const found = findItemsArray(el, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof obj === "object") {
    for (const key of Object.keys(obj)) {
      const found = findItemsArray(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function normalizeItem(raw, i) {
  const code = pick(raw, ["itemCode", "stockCode", "code", "symbolCode", "itemcode", "cd"]);
  const name = pick(raw, ["stockName", "itemName", "name", "itemname", "nm"]);
  const price = toFloat(pick(raw, ["closePrice", "nowPrice", "price", "closePriceRaw", "stockEndPrice"]));

  const changeField = pick(raw, ["compareToPreviousClosePrice", "changePrice", "fluctuations", "compareToPreviousPrice"]);
  const changeAbs = typeof changeField === "object" ? toFloat(changeField && changeField.value) : toFloat(changeField);

  const changePercent = toFloat(
    pick(raw, ["fluctuationsRatio", "changeRate", "prevChangeRate", "fluctuationRate", "risefallRate"])
  );

  let dirCode = pick(raw, ["compareToPreviousPrice"]);
  dirCode = typeof dirCode === "object" ? dirCode && dirCode.code : pick(raw, ["risefall", "riseFall", "sign"]);

  let direction = "flat";
  if (dirCode !== undefined && dirCode !== null) {
    if (DOWN_CODES.has(String(dirCode))) direction = "down";
    else if (UP_CODES.has(String(dirCode))) direction = "up";
  } else if (changeAbs !== null && changeAbs !== 0) {
    direction = changeAbs > 0 ? "up" : "down";
  } else if (changePercent !== null && changePercent !== 0) {
    direction = changePercent > 0 ? "up" : "down";
  }

  if (price === null || !name) return null;

  const sign = direction === "down" ? -1 : 1;

  return {
    rank: i + 1,
    code: code ? String(code) : "",
    name: String(name),
    price,
    change: changeAbs === null ? 0 : Math.abs(changeAbs) * sign,
    changePercent: changePercent === null ? 0 : Math.abs(changePercent) * sign,
    direction,
  };
}

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "application/json",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const type = req.query.type || "quant";
  const label = LABELS[type];
  if (!label) {
    res.status(400).json({ error: "지원하지 않는 랭킹 종류입니다." });
    return;
  }

  try {
    let url;
    if (type === "popular") {
      url = SEARCH_TOP_URL;
    } else {
      const params = new URLSearchParams({
        tradeType: "KRX",
        marketType: "ALL",
        orderType: ORDER_TYPE[type],
        startIdx: "0",
        pageSize: "10",
      });
      url = `${BASE}?${params.toString()}`;
    }

    const json = await fetchJson(url);
    const rawItems = findItemsArray(json) || [];
    const items = rawItems
      .slice(0, 10)
      .map((raw, i) => normalizeItem(raw, i))
      .filter(Boolean);

    if (!items.length) {
      throw new Error("응답에서 종목 데이터를 찾지 못함");
    }

    res.status(200).json({
      type,
      label,
      items,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(200).json({
      type,
      label,
      items: [],
      error: err.message || "알 수 없는 오류",
      fetchedAt: new Date().toISOString(),
    });
  }
};

// 내 관심종목 시세 (국내 + 미국 주식)
// 국내: /api/quote?codes=005930,000660
// 미국: /api/quote?market=us&codes=AAPL.O,TSLA.O,SPY  (네이버 로이터코드 또는 티커)
//
// 1순위: 네이버가 자기 웹페이지에서 쓰는 실시간 JSON (polling.finance.naver.com)
//        → 지수 카드에서 이미 잘 쓰고 있는 것과 같은 서버라 거의 실시간이에요.
// 2순위: 네이버 모바일 증권 JSON (m.stock.naver.com/api/stock/{code}/basic)
//
// 응답 필드 이름은 실제 호출 전엔 100% 확신할 수 없어서, 후보 이름을 여러 개
// 시도하는 방식(pick)으로 방어적으로 짰어요.
//
// 미국 주식은 "최대한 빠르게"를 위해 이 순서로 시도해요.
// 1순위: 네이버 해외주식 실시간 JSON (polling.finance.naver.com/api/realtime/worldstock)
// 2순위: 네이버 해외주식 기본 JSON (api.stock.naver.com/stock/{코드}/basic)
// 3순위: 야후 차트 API (지수 카드에서 쓰는 것과 같은 곳)
// 응답에 tradedAt(체결 기준 시각)을 같이 내려줘서, 화면에서 실제 지연을 확인할 수 있어요.

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
    extended: normalizeOver(d.overMarketPriceInfo),
  };
}

// 프리마켓/애프터마켓 가격 (네이버 해외주식 응답의 overMarketPriceInfo)
function normalizeOver(o) {
  if (!o || typeof o !== "object") return null;
  const price = toFloat(pick(o, ["overPrice", "closePrice", "price"]));
  if (price === null) return null;
  let changePercent = toFloat(pick(o, ["fluctuationsRatio", "changeRate"]));
  let change = toFloat(pick(o, ["compareToPreviousClosePrice", "changePrice"]));
  const dirObj = o.compareToPreviousPrice;
  const dirCode = dirObj && typeof dirObj === "object" ? dirObj.code || dirObj.name : dirObj;
  if (dirCode !== undefined && dirCode !== null && DOWN_CODES.has(String(dirCode))) {
    if (changePercent) changePercent = -Math.abs(changePercent);
    if (change) change = -Math.abs(change);
  }
  const session = String(pick(o, ["tradingSessionType", "sessionType"]) || "");
  return {
    price,
    change: change || 0,
    changePercent: changePercent || 0,
    session: /PRE/i.test(session) ? "pre" : /AFTER|POST/i.test(session) ? "after" : session.toLowerCase(),
    tradedAt: pick(o, ["localTradedAt", "tradedAt"]) || null,
    status: pick(o, ["overMarketStatus", "marketStatus"]) || null,
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

/* ---------------- 미국 주식 ---------------- */
const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
const US_SUFFIXES = [".O", ".N", ".K", ".A"]; // 나스닥, 뉴욕, NYSE Arca(ETF), 아멕스

async function usFromNaverPolling(rc) {
  const json = await fetchJson(`https://polling.finance.naver.com/api/realtime/worldstock/stock/${encodeURIComponent(rc)}`);
  const d = json?.datas?.[0] || json?.data?.[0] || json?.result?.[0];
  const item = normalize(d, rc);
  if (!item) throw new Error("해외 실시간 없음");
  return { ...item, source: "naver-realtime" };
}

async function usFromNaverBasic(rc) {
  const json = await fetchJson(`https://api.stock.naver.com/stock/${encodeURIComponent(rc)}/basic`);
  const item = normalize(json?.datas?.[0] || json?.result || json, rc);
  if (!item) throw new Error("해외 기본 없음");
  return { ...item, source: "naver-basic" };
}

async function usFromYahoo(ticker) {
  let lastErr;
  for (const host of YAHOO_HOSTS) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m&includePrePost=true`;
      const json = await fetchJson(url);
      const result = json?.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta || typeof meta.regularMarketPrice !== "number") throw new Error("야후 데이터 없음");
      const prev = meta.previousClose ?? meta.chartPreviousClose;
      const price = meta.regularMarketPrice;
      const change = typeof prev === "number" ? price - prev : 0;
      const changePercent = typeof prev === "number" && prev ? (change / prev) * 100 : 0;

      // 장외(프리/애프터) 가격: 1분봉 마지막 값이 정규장 시간 밖이면 장외로 표시
      let extended = null;
      const ts = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];
      const reg = meta.currentTradingPeriod?.regular;
      for (let i = ts.length - 1; i >= 0; i--) {
        if (typeof closes[i] !== "number") continue;
        if (reg && (ts[i] < reg.start || ts[i] >= reg.end)) {
          const base = ts[i] >= (reg.end || 0) ? price : prev;
          extended = {
            price: closes[i],
            change: typeof base === "number" ? closes[i] - base : 0,
            changePercent: typeof base === "number" && base ? ((closes[i] - base) / base) * 100 : 0,
            session: ts[i] < reg.start ? "pre" : "after",
            tradedAt: new Date(ts[i] * 1000).toISOString(),
          };
        }
        break;
      }

      return {
        code: ticker,
        name: meta.longName || meta.shortName || ticker,
        price,
        change,
        changePercent,
        direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
        marketStatus: null,
        tradedAt: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
        extended,
        source: "yahoo",
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("야후 실패");
}

// code: "AAPL.O"(네이버 로이터코드) 또는 "AAPL"(티커만)
async function fetchUS(code) {
  const ticker = code.split(".")[0];
  const candidates = code.includes(".") ? [code] : US_SUFFIXES.map((s) => ticker + s);
  const errs = [];
  for (const rc of candidates) {
    try { return { ...(await usFromNaverPolling(rc)), code }; } catch (e) { errs.push(e.message); }
    if (code.includes(".")) {
      try { return { ...(await usFromNaverBasic(rc)), code }; } catch (e) { errs.push(e.message); }
    }
  }
  try { return { ...(await usFromYahoo(ticker.replace(/_/g, "-"))), code }; } catch (e) { errs.push(e.message); }
  throw new Error(errs.slice(-2).join(" / "));
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (String(req.query.market || "").toLowerCase() === "us") {
    const usCodes = String(req.query.codes || "")
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter((c) => /^[A-Z0-9][A-Z0-9._\-]{0,14}$/.test(c))
      .slice(0, MAX_CODES);
    const items = [];
    const errors = [];
    await Promise.all(
      usCodes.map(async (code) => {
        try { items.push(await fetchUS(code)); }
        catch (err) { errors.push(`${code}: ${err.message}`); }
      })
    );
    res.status(200).json({ market: "us", items, errors, fetchedAt: new Date().toISOString() });
    return;
  }

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

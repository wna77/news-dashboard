// 종목 검색 (자동완성) — 국내 / 미국 주식
// 국내: /api/search?q=삼성
// 미국: /api/search?market=us&q=애플  (한글 이름·티커 모두 가능)
//   1순위 네이버 자동완성(로이터코드 AAPL.O 같은 형태) → 2순위 야후 검색(티커)
//
// 1순위: 네이버 증권 자동완성 (ac.stock.naver.com)
// 2순위: 예전 네이버 금융 자동완성 (ac.finance.naver.com)
// 둘 다 실패해도 앱에서 6자리 종목코드를 직접 입력하면 추가할 수 있어요.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://stock.naver.com/" },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// 응답 어딘가에 있는 "종목 배열"을 찾음
function findArray(obj, depth) {
  depth = depth || 0;
  if (depth > 5 || obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) {
    if (obj.length && obj[0] && typeof obj[0] === "object" && !Array.isArray(obj[0])) {
      if (pick(obj[0], ["code", "itemCode", "reutersCode", "symbolCode"]) !== undefined) return obj;
    }
    for (const el of obj) {
      const f = findArray(el, depth + 1);
      if (f) return f;
    }
    return null;
  }
  if (typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      const f = findArray(obj[k], depth + 1);
      if (f) return f;
    }
  }
  return null;
}

async function fromNewAc(q) {
  const json = await fetchJson(
    `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`
  );
  const arr = findArray(json) || [];
  return arr
    .map((it) => {
      const code = String(pick(it, ["code", "itemCode", "symbolCode", "reutersCode"]) || "");
      const name = String(pick(it, ["name", "itemName", "stockName"]) || "");
      const nation = String(pick(it, ["nationCode", "nation"]) || "");
      const market = String(pick(it, ["typeName", "marketName", "typeCode"]) || "");
      return { code, name, market, nation };
    })
    .filter((it) => /^[0-9A-Z]{6}$/.test(it.code) && it.name && (!it.nation || it.nation === "KOR"));
}

async function fromOldAc(q) {
  const url =
    `https://ac.finance.naver.com/ac?q=${encodeURIComponent(q)}` +
    "&q_enc=utf-8&t_koreng=1&st=111&r_format=json&r_enc=utf-8&r_unicode=0&r_lt=111";
  const json = await fetchJson(url);
  // 구조: items: [ [ [이름], [코드], [시장], ... ], ... ]
  const groups = json?.items || [];
  const out = [];
  groups.forEach((group) => {
    (Array.isArray(group) ? group : []).forEach((row) => {
      if (!Array.isArray(row)) return;
      const name = Array.isArray(row[0]) ? row[0][0] : row[0];
      const code = Array.isArray(row[1]) ? row[1][0] : row[1];
      const market = Array.isArray(row[2]) ? row[2][0] : row[2];
      if (name && /^[0-9A-Z]{6}$/.test(String(code))) {
        out.push({ code: String(code), name: String(name), market: market ? String(market) : "", nation: "KOR" });
      }
    });
  });
  return out;
}

/* ---------------- 미국 ---------------- */
const US_EXCHANGES = new Set(["NMS", "NGM", "NCM", "NYQ", "PCX", "ASE", "BTS", "NAS", "NYS", "PNK"]);

async function usFromNaver(q) {
  const json = await fetchJson(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`);
  const arr = findArray(json) || [];
  return arr
    .map((it) => {
      const nation = String(pick(it, ["nationCode", "nation"]) || "");
      const rc = String(pick(it, ["reutersCode", "symbolCode", "code"]) || "");
      const ticker = String(pick(it, ["code", "symbolCode"]) || rc.split(".")[0]);
      return {
        code: rc.includes(".") ? rc : ticker,
        ticker: ticker.split(".")[0],
        name: String(pick(it, ["name", "itemName", "stockName"]) || ""),
        market: String(pick(it, ["typeName", "marketName", "typeCode"]) || ""),
        nation,
      };
    })
    .filter((it) => it.nation === "USA" && it.code && it.name);
}

async function usFromYahoo(q) {
  const json = await fetchJson(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`
  );
  return (json?.quotes || [])
    .filter((x) => x && x.symbol && (x.quoteType === "EQUITY" || x.quoteType === "ETF") && US_EXCHANGES.has(x.exchange))
    .map((x) => ({
      code: String(x.symbol).toUpperCase(),
      ticker: String(x.symbol).toUpperCase(),
      name: x.shortname || x.longname || x.symbol,
      market: x.exchDisp || x.exchange || "",
      nation: "USA",
    }));
}

async function searchUS(q) {
  const errors = [];
  let items = [];
  try { items = await usFromNaver(q); } catch (e) { errors.push(`네이버: ${e.message}`); }
  if (!items.length) {
    try { items = await usFromYahoo(q); } catch (e) { errors.push(`야후: ${e.message}`); }
  }
  const seen = new Set();
  items = items.filter((it) => (seen.has(it.ticker) ? false : (seen.add(it.ticker), true))).slice(0, 10);
  return { items, errors };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = String(req.query.q || "").trim();
  if (!q) {
    res.status(200).json({ items: [], errors: [] });
    return;
  }

  if (String(req.query.market || "").toLowerCase() === "us") {
    res.status(200).json(await searchUS(q));
    return;
  }

  const errors = [];
  let items = [];

  try {
    items = await fromNewAc(q);
  } catch (e) {
    errors.push(`검색1: ${e.message}`);
  }
  if (!items.length) {
    try {
      items = await fromOldAc(q);
    } catch (e) {
      errors.push(`검색2: ${e.message}`);
    }
  }

  // 중복 제거 후 10개까지
  const seen = new Set();
  items = items.filter((it) => (seen.has(it.code) ? false : (seen.add(it.code), true))).slice(0, 10);

  res.status(200).json({ items, errors });
};

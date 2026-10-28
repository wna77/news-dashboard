// 국내 지수(코스피·코스닥)는 네이버가 자기 웹페이지에서 쓰는 실시간 JSON을 그대로 가져와요.
// (로그인/키 불필요, 지연 없음 — finance.naver.com 화면과 같은 값)
// 해외 지수(S&P500·나스닥·다우존스)는 야후 파이낸스 공개 차트 API를 씁니다.
// (키 불필요하지만 보통 15~20분 지연)

const DOMESTIC = [
  { code: "KOSPI", name: "코스피", short: "KOSPI", realtime: true },
  { code: "KOSDAQ", name: "코스닥", short: "KOSDAQ", realtime: true },
];

const OVERSEAS = [
  { symbol: "^GSPC", name: "S&P 500", short: "S&P", realtime: false },
  { symbol: "^IXIC", name: "나스닥종합", short: "NASDAQ", realtime: false },
  { symbol: "^DJI", name: "다우존스", short: "DOW", realtime: false },
];

const DOWN_CODES = new Set(["3", "4", "5"]);
const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

function toFloat(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

async function fetchDomestic(cfg) {
  const url = `https://polling.finance.naver.com/api/realtime/domestic/index/${cfg.code}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "application/json",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const data = await resp.json();
  const d = data?.datas?.[0];
  if (!d) throw new Error("데이터 없음");

  const price = toFloat(d.closePriceRaw ?? d.closePrice);
  let change = toFloat(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice);
  let changePercent = toFloat(d.fluctuationsRatioRaw ?? d.fluctuationsRatio);

  const dirCode = d.compareToPreviousPrice?.code;
  if (DOWN_CODES.has(String(dirCode))) {
    if (change !== null && change > 0) change = -change;
    if (changePercent !== null && changePercent > 0) changePercent = -changePercent;
  }

  if (price === null) throw new Error("가격 파싱 실패");

  return {
    code: cfg.code,
    name: cfg.name,
    short: cfg.short,
    price,
    change: change ?? 0,
    changePercent: changePercent ?? 0,
    direction: (change ?? 0) > 0 ? "up" : (change ?? 0) < 0 ? "down" : "flat",
    realtime: true,
    tradedAt: d.localTradedAt || null,
  };
}

async function fetchOverseas(cfg) {
  let lastErr;
  for (const host of YAHOO_HOSTS) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(cfg.symbol)}?range=1d&interval=1d`;
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "application/json",
        },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) throw new Error("데이터 없음");

      const price = meta.regularMarketPrice;
      const prevClose = meta.previousClose ?? meta.chartPreviousClose;
      if (typeof price !== "number" || typeof prevClose !== "number") {
        throw new Error("가격 정보 없음");
      }

      const change = price - prevClose;
      const changePercent = (change / prevClose) * 100;

      return {
        code: cfg.symbol,
        name: cfg.name,
        short: cfg.short,
        price,
        change,
        changePercent,
        direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
        realtime: false,
        tradedAt: null,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("알 수 없는 오류");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const errors = [];
  const items = [];

  await Promise.all([
    ...DOMESTIC.map(async (cfg) => {
      try {
        items.push(await fetchDomestic(cfg));
      } catch (err) {
        errors.push(`${cfg.name} 가져오기 실패: ${err.message}`);
      }
    }),
    ...OVERSEAS.map(async (cfg) => {
      try {
        items.push(await fetchOverseas(cfg));
      } catch (err) {
        errors.push(`${cfg.name} 가져오기 실패: ${err.message}`);
      }
    }),
  ]);

  // DOMESTIC + OVERSEAS 순서로 정렬
  const order = [...DOMESTIC.map((c) => c.code), ...OVERSEAS.map((c) => c.symbol)];
  items.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));

  res.status(200).json({
    items,
    errors,
    fetchedAt: new Date().toISOString(),
  });
};

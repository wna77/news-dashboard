// 국내 지수(코스피·코스닥)는 네이버가 자기 웹페이지에서 쓰는 실시간 JSON을 그대로 가져와요.
// (로그인/키 불필요, 지연 없음 — finance.naver.com 화면과 같은 값)
// 해외 지수(S&P500·나스닥·다우존스)는 야후 파이낸스 공개 차트 API를 씁니다.
// (키 불필요하지만 보통 15~20분 지연)
//
// 접속하자마자 차트가 텅 비어있지 않도록, 오늘 하루치 분봉(5분 간격) 데이터를
// 야후 차트 API에서 한 번에 받아와 `spark`로 같이 내려줍니다. (국내 지수도 야후에
// 같은 이름의 지수(^KS11, ^KQ11)가 있어서 분봉 모양만 참고용으로 가져오고,
// 실제 "현재가"는 더 정확한 네이버 실시간 값을 그대로 씁니다.)

const DOMESTIC = [
  { code: "KOSPI", name: "코스피", short: "KOSPI", realtime: true, yahooSymbol: "^KS11" },
  { code: "KOSDAQ", name: "코스닥", short: "KOSDAQ", realtime: true, yahooSymbol: "^KQ11" },
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

// 야후 차트 API에서 오늘 하루치 분봉(5분)을 받아옵니다. meta(현재가 등)와
// spark(분봉 점들)를 같이 돌려줘요. 실패하면 던짐.
async function fetchYahooChart(symbol) {
  let lastErr;
  for (const host of YAHOO_HOSTS) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "application/json",
        },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();
      const result = data?.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta) throw new Error("데이터 없음");

      const timestamps = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];
      const spark = [];
      for (let i = 0; i < timestamps.length; i++) {
        const c = closes[i];
        if (typeof c === "number") spark.push({ t: timestamps[i] * 1000, p: c });
      }

      return { meta, spark };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("알 수 없는 오류");
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

  // 분봉 모양은 야후에서 참고용으로만 가져옴 — 실패해도 현재가(네이버)는 그대로 살림
  let spark = [];
  try {
    const chart = await fetchYahooChart(cfg.yahooSymbol);
    spark = chart.spark;
  } catch (e) {
    // 분봉은 없어도 괜찮음 (클라이언트에서 직접 쌓아가며 채움)
  }
  // 네이버 실시간 현재가를 마지막 점으로 추가해서 분봉 끝과 실제 현재가가 이어지도록 함
  spark.push({ t: Date.now(), p: price });

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
    marketStatus: d.marketStatus || null, // "OPEN" / "CLOSE" 등 — 장 상태 표시에 참고
    spark,
  };
}

async function fetchOverseas(cfg) {
  const { meta, spark } = await fetchYahooChart(cfg.symbol);

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
    spark,
  };
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

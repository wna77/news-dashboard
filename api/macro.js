// 간밤 시장 줄: 나스닥 선물 · 미국 10년물 금리 · VIX · 금 · WTI 유가 · 비트코인
// 야후 차트 API (지수 카드에서 이미 쓰는 곳)라 키·비용 없음.
// 선물·VIX는 보통 10~15분 지연, 비트코인은 거의 실시간이에요.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

const TARGETS = [
  { symbol: "NQ=F", key: "nq", name: "나스닥선물", digits: 2 },
  { symbol: "^TNX", key: "us10y", name: "美10년물", digits: 3, unit: "%", absChange: true },
  { symbol: "^VIX", key: "vix", name: "VIX", digits: 2 },
  { symbol: "GC=F", key: "gold", name: "금", digits: 1, prefix: "$" },
  { symbol: "CL=F", key: "wti", name: "WTI", digits: 2, prefix: "$" },
  { symbol: "BTC-USD", key: "btc", name: "비트코인", digits: 0, prefix: "$" },
];

async function fetchChart(symbol) {
  let lastErr;
  for (const host of YAHOO_HOSTS) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
      const resp = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta || typeof meta.regularMarketPrice !== "number") throw new Error("데이터 없음");
      return meta;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("알 수 없는 오류");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const items = [];
  const errors = [];

  await Promise.all(
    TARGETS.map(async (t) => {
      try {
        const meta = await fetchChart(t.symbol);
        const price = meta.regularMarketPrice;
        const prev = meta.previousClose ?? meta.chartPreviousClose;
        const change = typeof prev === "number" ? price - prev : 0;
        const changePercent = typeof prev === "number" && prev ? (change / prev) * 100 : 0;
        items.push({
          key: t.key,
          name: t.name,
          price,
          change,
          changePercent,
          digits: t.digits,
          unit: t.unit || "",
          prefix: t.prefix || "",
          absChange: !!t.absChange, // 금리는 %가 아니라 몇 %p 움직였는지로 표시
          direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
          tradedAt: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
        });
      } catch (err) {
        errors.push(`${t.name}: ${err.message}`);
      }
    })
  );

  const order = TARGETS.map((t) => t.key);
  items.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  res.status(200).json({ items, errors, fetchedAt: new Date().toISOString() });
};

// 네이버 금융 환율 페이지에서 주요 통화 환율을 가져와요.
// 페이지 구조가 바뀌면 파싱이 실패할 수 있어서, 실패해도 전체 API가 죽지 않고
// errors 배열에 이유를 담아 보내도록 만들었어요.

const CURRENCY_LABELS = {
  FX_USDKRW: { name: "미국", unit: "USD", flag: "🇺🇸" },
  FX_JPYKRW100: { name: "일본", unit: "JPY(100엔)", flag: "🇯🇵" },
  FX_THBKRW: { name: "태국", unit: "THB", flag: "🇹🇭" },
  FX_EURKRW: { name: "유럽", unit: "EUR", flag: "🇪🇺" },
  FX_CNYKRW: { name: "중국", unit: "CNY", flag: "🇨🇳" },
};

const TARGET_ORDER = [
  "FX_USDKRW",
  "FX_JPYKRW100",
  "FX_THBKRW",
  "FX_EURKRW",
  "FX_CNYKRW",
];

function parseRows(html) {
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const results = [];

  rows.forEach((row) => {
    const cdMatch = row.match(/marketindexCd=([A-Z0-9_]+)/);
    if (!cdMatch) return;
    const cd = cdMatch[1];
    if (!TARGET_ORDER.includes(cd)) return;

    const saleMatch = row.match(/class="sale">\s*([\d,.]+)\s*</);
    if (!saleMatch) return;

    const changeMatch = row.match(/class="change">\s*([\d,.]+)\s*</);
    const isUp = /상승|class="[^"]*\bup\b[^"]*"|▲/.test(row);
    const isDown = /하락|class="[^"]*\bdown\b[^"]*"|▼/.test(row);

    results.push({
      code: cd,
      ...CURRENCY_LABELS[cd],
      rate: saleMatch[1],
      change: changeMatch ? changeMatch[1] : null,
      direction: isUp ? "up" : isDown ? "down" : "flat",
    });
  });

  return results;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const errors = [];
  let items = [];

  try {
    const resp = await fetch(
      "https://finance.naver.com/marketindex/exchangeList.naver",
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      }
    );

    if (!resp.ok) {
      throw new Error(`네이버 금융 응답 오류: ${resp.status}`);
    }

    const html = await resp.text();
    const parsed = parseRows(html);

    // 순서를 TARGET_ORDER 기준으로 정렬
    items = TARGET_ORDER.map((cd) => parsed.find((p) => p.code === cd)).filter(
      Boolean
    );

    if (items.length === 0) {
      errors.push("환율 데이터를 찾지 못했습니다 (페이지 구조 변경 가능성).");
    }
  } catch (err) {
    errors.push(String(err.message || err));
  }

  res.status(200).json({
    items,
    errors,
    fetchedAt: new Date().toISOString(),
  });
};

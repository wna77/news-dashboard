// 네이버 환율계산기 위젯이 쓰는 공개 JSON 엔드포인트를 사용해요.
// (finance.naver.com의 구 환율 테이블 페이지는 더 이상 응답하지 않아서 이 방식으로 교체함)

const TARGETS = [
  { code: "USD", name: "미국", unit: "USD", flag: "🇺🇸", per: 1 },
  { code: "JPY", name: "일본", unit: "JPY(100엔)", flag: "🇯🇵", per: 100 },
  { code: "THB", name: "태국", unit: "THB", flag: "🇹🇭", per: 1 },
  { code: "EUR", name: "유럽", unit: "EUR", flag: "🇪🇺", per: 1 },
  { code: "CNY", name: "중국", unit: "CNY", flag: "🇨🇳", per: 1 },
];

async function fetchRate(code) {
  const params = new URLSearchParams({
    key: "calculator",
    pkid: "141",
    q: "환율",
    where: "m",
    u1: "keb",
    u2: "1",
    u3: code,
    u4: "KRW",
    u6: "standardUnit",
    u7: "0",
    u8: "down",
  });

  const url = `https://m.search.naver.com/p/csearch/content/qapirender.nhn?${params.toString()}`;

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("응답을 해석할 수 없음");
  }

  if (!data.country || data.country.length < 2) {
    throw new Error("환율 데이터 없음");
  }

  const fromValue = parseFloat(String(data.country[0].value).replace(/,/g, ""));
  const toValue = parseFloat(String(data.country[1].value).replace(/,/g, ""));

  if (!fromValue || !toValue) {
    throw new Error("환율 값 파싱 실패");
  }

  return toValue / fromValue; // KRW per 1 unit of `code`
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const errors = [];
  const resultMap = {};

  await Promise.all(
    TARGETS.map(async (t) => {
      try {
        const perUnitRate = await fetchRate(t.code);
        const displayRate = perUnitRate * t.per;
        resultMap[t.code] = {
          code: t.code,
          name: t.name,
          unit: t.unit,
          flag: t.flag,
          rate: displayRate.toLocaleString("ko-KR", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }),
          rawRate: displayRate,
        };
      } catch (err) {
        errors.push(`${t.name}(${t.code}) 가져오기 실패: ${err.message}`);
      }
    })
  );

  const items = TARGETS.map((t) => resultMap[t.code]).filter(Boolean);

  res.status(200).json({
    items,
    errors,
    fetchedAt: new Date().toISOString(),
  });
};

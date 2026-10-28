const { XMLParser } = require("fast-xml-parser");

const PER_SOURCE_COUNT = 10;
const OUTPUT_LIMIT = 12;

function stripTags(str = "") {
  return str
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .trim();
}

// 제목을 비교하기 쉬운 형태로 정규화 (공백/특수문자/조사성 꼬리표 제거)
function normalizeTitle(title = "") {
  return title
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, "") // [단독], [속보] 같은 대괄호 태그 제거
    .replace(/\([^)]*\)/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "") // 문자/숫자만 남김
    .trim();
}

// 두 정규화된 제목의 유사도 (문자 단위 자카드 유사도, 0~1)
function titleSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const setA = new Set(a.match(/.{1,2}/g) || []); // 2-gram
  const setB = new Set(b.match(/.{1,2}/g) || []);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  setA.forEach((g) => {
    if (setB.has(g)) intersection += 1;
  });
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const SIMILARITY_THRESHOLD = 0.55;

function dedupe(items) {
  const merged = [];

  items.forEach((item) => {
    const norm = normalizeTitle(item.title);
    const existing = merged.find(
      (m) => titleSimilarity(m._norm, norm) >= SIMILARITY_THRESHOLD
    );

    if (existing) {
      if (!existing.sources.includes(item.source)) {
        existing.sources.push(item.source);
      }
      // 더 최근 기사의 시간으로 갱신, 링크는 네이버 쪽을 우선
      if (new Date(item.pubDate) > new Date(existing.pubDate)) {
        existing.pubDate = item.pubDate;
      }
      if (item.sourceType === "naver" && existing.sourceType !== "naver") {
        existing.link = item.link;
        existing.sourceType = "naver";
        existing.press = item.press || existing.press;
      }
    } else {
      merged.push({
        title: item.title,
        link: item.link,
        pubDate: item.pubDate,
        press: item.press || "",
        sources: [item.source],
        sourceType: item.sourceType,
        _norm: norm,
      });
    }
  });

  return merged
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, OUTPUT_LIMIT)
    .map(({ _norm, sourceType, ...rest }) => rest);
}

async function fetchNaver(query, clientId, clientSecret) {
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(
    query
  )}&display=${PER_SOURCE_COUNT}&sort=date`;

  const resp = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": clientId,
      "X-Naver-Client-Secret": clientSecret,
    },
  });

  if (!resp.ok) {
    throw new Error(`네이버 API 오류: ${resp.status}`);
  }

  const data = await resp.json();

  return (data.items || []).map((item) => ({
    title: stripTags(item.title),
    link: item.originallink || item.link,
    source: "네이버뉴스",
    sourceType: "naver",
    pubDate: item.pubDate,
  }));
}

async function fetchGoogle(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    query
  )}&hl=ko&gl=KR&ceid=KR:ko`;

  const resp = await fetch(url);

  if (!resp.ok) {
    throw new Error(`구글 뉴스 오류: ${resp.status}`);
  }

  const xml = await resp.text();
  const parser = new XMLParser();
  const parsed = parser.parse(xml);

  const items = parsed?.rss?.channel?.item || [];
  const list = Array.isArray(items) ? items : [items];

  return list.slice(0, PER_SOURCE_COUNT).map((item) => {
    const rawTitle = typeof item.title === "string" ? item.title : "";
    const lastDash = rawTitle.lastIndexOf(" - ");
    const title = lastDash > -1 ? rawTitle.slice(0, lastDash) : rawTitle;
    const press = lastDash > -1 ? rawTitle.slice(lastDash + 3) : "Google News";

    return {
      title: stripTags(title),
      link: item.link,
      source: "구글뉴스",
      sourceType: "google",
      press,
      pubDate: item.pubDate,
    };
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const query = (req.query.q || "").trim();

  if (!query) {
    res.status(400).json({ error: "검색어(q)가 필요합니다." });
    return;
  }

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  const errors = [];
  let naverItems = [];
  let googleItems = [];

  try {
    if (clientId && clientSecret) {
      naverItems = await fetchNaver(query, clientId, clientSecret);
    } else {
      errors.push("네이버 API 키가 설정되지 않았습니다.");
    }
  } catch (err) {
    errors.push(String(err.message || err));
  }

  try {
    googleItems = await fetchGoogle(query);
  } catch (err) {
    errors.push(String(err.message || err));
  }

  const merged = dedupe([...naverItems, ...googleItems]);

  res.status(200).json({
    items: merged,
    errors,
    fetchedAt: new Date().toISOString(),
  });
};

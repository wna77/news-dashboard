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

// 흔한 조사/어미 꼬리를 느슨하게 제거 (완벽하지 않아도 비교용으론 충분)
const PARTICLE_TAIL = /(으로서|이라며|이라고|라며|라고|에서는|에서|으로|까지|부터|이지만|지만|하다|한다|했다|했|이|가|을|를|은|는|의|에|도|와|과|만|께|이며|며)$/;

function stripParticle(word) {
  const stripped = word.replace(PARTICLE_TAIL, "");
  return stripped.length >= 2 ? stripped : word;
}

// 제목을 비교 가능한 "단어 집합"으로 정규화 (어순이 달라도 비교 가능하도록)
function titleWordSet(title = "") {
  const cleaned = title
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ") // [단독], [속보] 같은 대괄호 태그 제거
    .replace(/[^\p{L}\p{N}\s]/gu, " "); // 문장부호 제거, 공백은 유지

  const words = cleaned
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .map(stripParticle)
    .filter((w) => w.length >= 2);

  return new Set(words);
}

// 두 단어집합의 자카드 유사도 (0~1). 어순이 달라도 내용이 같으면 높게 나옴
function titleSimilarity(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  setA.forEach((w) => {
    if (setB.has(w)) intersection += 1;
  });
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const SIMILARITY_THRESHOLD = 0.4;

function dedupe(items) {
  const merged = [];

  items.forEach((item) => {
    const norm = titleWordSet(item.title);
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
      // 단어 집합을 합쳐서, 이후 등장하는 비슷한 제목도 더 잘 묶이도록 함
      norm.forEach((w) => existing._norm.add(w));
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

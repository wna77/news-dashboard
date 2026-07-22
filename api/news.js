const { XMLParser } = require("fast-xml-parser");

const RESULT_COUNT = 7;

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

async function fetchNaver(query, clientId, clientSecret) {
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(
    query
  )}&display=${RESULT_COUNT}&sort=date`;

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

  return list.slice(0, RESULT_COUNT).map((item) => {
    const rawTitle = typeof item.title === "string" ? item.title : "";
    // 구글 뉴스 제목은 보통 "제목 - 출처" 형식
    const lastDash = rawTitle.lastIndexOf(" - ");
    const title = lastDash > -1 ? rawTitle.slice(0, lastDash) : rawTitle;
    const source = lastDash > -1 ? rawTitle.slice(lastDash + 3) : "Google News";

    return {
      title: stripTags(title),
      link: item.link,
      source,
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

  const results = { naver: [], google: [], errors: [] };

  try {
    if (clientId && clientSecret) {
      results.naver = await fetchNaver(query, clientId, clientSecret);
    } else {
      results.errors.push("네이버 API 키가 설정되지 않았습니다.");
    }
  } catch (err) {
    results.errors.push(String(err.message || err));
  }

  try {
    results.google = await fetchGoogle(query);
  } catch (err) {
    results.errors.push(String(err.message || err));
  }

  res.status(200).json(results);
};

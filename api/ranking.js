// 네이버 금융의 "국내증시 > 시세" 랭킹 페이지를 그대로 가져와서 보여줘요.
// (거래대금상위/상승/하락/시가총액/거래량상위/인기종목 — 네이버 웹사이트 메뉴와 동일한 소스)
// 이 페이지들은 네이버가 아주 오래전부터 운영해 온 구형(EUC-KR) HTML 페이지라서
// 가볍고 안정적이지만, 혹시 네이버가 페이지 구조를 바꾸면 이 파일만 고치면 돼요.

const iconv = require("iconv-lite");
const cheerio = require("cheerio");

const TABS = {
  quant: { path: "sise_quant.naver", label: "거래대금상위" },
  rise: { path: "sise_rise.naver", label: "상승" },
  fall: { path: "sise_fall.naver", label: "하락" },
  marketcap: { path: "sise_market_sum.naver", label: "시가총액" },
  volume: { path: "sise_trading_volume.naver", label: "거래량상위" },
  popular: { path: "lastsearch2.naver", label: "인기종목" },
};

function toFloat(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/,/g, "").replace(/%/g, ""));
  return isNaN(n) ? null : n;
}

async function fetchHtml(path) {
  const url = `https://finance.naver.com/sise/${path}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  return iconv.decode(buf, "euc-kr");
}

function parseTable(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $("table.type_2 tr").each((_, el) => {
    const $row = $(el);
    const tds = $row.find("td");
    if (tds.length < 3) return;

    let nameIdx = -1;
    let name = "";
    let code = "";

    tds.each((i, td) => {
      const $td = $(td);
      const $link = $td.find("a").filter((_, a) => /code=\d{6}/.test($(a).attr("href") || ""));
      if ($link.length && nameIdx === -1) {
        nameIdx = i;
        name = $link.first().text().trim();
        const href = $link.first().attr("href") || "";
        const m = href.match(/code=(\d{6})/);
        code = m ? m[1] : "";
      }
    });

    if (nameIdx === -1 || !name || !code) return;

    const texts = [];
    tds.each((i, td) => texts.push($(td).text().replace(/\s+/g, " ").trim()));

    const price = toFloat(texts[nameIdx + 1]);
    const changeAbs = toFloat(texts[nameIdx + 2]);
    const changePercentAbs = toFloat(texts[nameIdx + 3]);
    if (price === null) return;

    const rowHtml = $row.html() || "";
    let direction = "flat";
    if (/ico_up|red02|상한가/.test(rowHtml)) direction = "up";
    else if (/ico_down|blue02|하한가/.test(rowHtml)) direction = "down";

    const sign = direction === "down" ? -1 : 1;

    rows.push({
      code,
      name,
      price,
      change: changeAbs === null ? 0 : Math.abs(changeAbs) * sign,
      changePercent: changePercentAbs === null ? 0 : Math.abs(changePercentAbs) * sign,
      direction,
    });
  });

  return rows;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const type = req.query.type || "quant";
  const tab = TABS[type];
  if (!tab) {
    res.status(400).json({ error: "지원하지 않는 랭킹 종류입니다." });
    return;
  }

  try {
    const html = await fetchHtml(tab.path);
    const items = parseTable(html)
      .slice(0, 10)
      .map((r, i) => ({ rank: i + 1, ...r }));

    res.status(200).json({
      type,
      label: tab.label,
      items,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(200).json({
      type,
      label: tab.label,
      items: [],
      error: err.message,
      fetchedAt: new Date().toISOString(),
    });
  }
};

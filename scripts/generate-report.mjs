#!/usr/bin/env node

import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const DEFAULT_OUTPUT = "/workspace/stock-report-sample.html";
const API_BASE = process.env.STOCK_API_BASE ?? "http://localhost:3000/api/stocks";
const TICKERS_FILE = new URL("../src/config/tickers.ts", import.meta.url);
const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const CHROME_PATH =
  process.env.CHROME_PATH ??
  process.env.PUPPETEER_EXECUTABLE_PATH ??
  "/usr/bin/google-chrome-stable";

/** Phone viewport CSS width (device px ≈ this × deviceScaleFactor). */
const PHONE_VIEWPORT_WIDTH = 414;
const PHONE_VIEWPORT_HEIGHT = 900;
const DEVICE_SCALE_FACTOR = 3;
/** Target ~2 tiles per page; 3 only when cards are short enough. */
const TARGET_TILES_PER_PAGE = 2;
const MAX_TILES_PER_PAGE = 3;
/** Soft cap on page content height in CSS px (~1–1.5 phone screens). */
const MAX_PAGE_CSS_HEIGHT = 1100;

const htmlEscape = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const formatPacific = (date) => new Intl.DateTimeFormat("en-US", {
  timeZone: PACIFIC_TIME_ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
}).format(date);

const formatNumber = (value, digits = 2) => Number.isFinite(Number(value))
  ? Number(value).toFixed(digits)
  : "—";

const formatPrice = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toFixed(2)}` : "—";
};

const formatChange = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number.toFixed(2)}%` : "—";
};

const displayValue = (key, value) => {
  if (value === null || value === undefined || value === "") return "—";
  if (key === "price" || key === "targetPrice") return formatPrice(value);
  if (key === "changePercent") return formatChange(value);
  if (key === "forwardPE") return formatNumber(value, 1);
  if (key === "fetchedAt") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : formatPacific(date);
  }
  if (typeof value === "number") return formatNumber(value);
  return String(value);
};

const labelFor = (key) => ({
  symbol: "Symbol",
  name: "Name",
  price: "Price",
  priceLabel: "Price type",
  changePercent: "Daily change",
  forwardPE: "Forward PE",
  recommendation: "Consensus",
  targetPrice: "Target price",
  newsTitle: "Latest news",
  newsUrl: "News link",
  sparkline: "5-day closes",
  marketState: "Market state",
  fetchedAt: "Fetched",
}[key] ?? key.replace(/[A-Z]/g, (letter) => ` ${letter}`).replace(/^./, (letter) => letter.toUpperCase()));

const getTickers = async () => {
  const source = await readFile(TICKERS_FILE, "utf8");
  const match = source.match(/export\s+const\s+TICKERS[^=]*=\s*\[([\s\S]*?)\]/);
  if (!match) throw new Error(`Could not parse tickers from ${TICKERS_FILE.pathname}`);
  const tickers = [...match[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]);
  if (!tickers.length) throw new Error(`No tickers found in ${TICKERS_FILE.pathname}`);
  return tickers;
};

const fetchTicker = async (symbol) => {
  const response = await fetch(`${API_BASE}/${encodeURIComponent(symbol)}`, {
    headers: { accept: "application/json" },
  });
  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    data = { error: body || `HTTP ${response.status}` };
  }
  if (!response.ok || data.error) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
};

const fetchAll = async (tickers) => {
  const results = [];
  const batchSize = 6;
  for (let index = 0; index < tickers.length; index += batchSize) {
    const batch = tickers.slice(index, index + batchSize);
    results.push(...await Promise.all(batch.map(async (symbol) => {
      try {
        return { symbol, data: await fetchTicker(symbol), error: null };
      } catch (error) {
        return { symbol, data: null, error: error instanceof Error ? error.message : String(error) };
      }
    })));
  }
  return results;
};

const validSparkline = (value) => Array.isArray(value)
  ? value.map(Number).filter(Number.isFinite).slice(-5)
  : [];

const sparklineMarkup = (data, symbol) => {
  const values = validSparkline(data.sparkline);
  if (!values.length) {
    return `<div class="sparkline-empty" aria-label="No 5-day sparkline data">—</div>`;
  }

  const width = 320;
  const height = 150;
  const padding = 8;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => {
    const x = values.length === 1
      ? width / 2
      : padding + (index / (values.length - 1)) * (width - padding * 2);
    const y = padding + (1 - (value - min) / range) * (height - padding * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const color = values.at(-1) > values[0] ? "var(--up)" : "var(--down)";
  const label = `${symbol} 5-day closes: ${values.map((value) => value.toFixed(2)).join(", ")}`;

  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="${htmlEscape(label)}" preserveAspectRatio="none">
        <polyline points="${points}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="sparkline-values">${htmlEscape(label)}</div>`;
};

const newsMarkup = (data) => {
  if (!data.newsTitle || !data.newsUrl) return "";
  return `<div class="news"><div class="news-label">Latest news</div><a href="${htmlEscape(data.newsUrl)}" target="_blank" rel="noopener">${htmlEscape(data.newsTitle)}</a></div>`;
};

const cardMarkup = ({ symbol, data, error }) => {
  if (error) {
    return `<article class="card error-card">
      <header><h2>${htmlEscape(symbol)}</h2><span class="session">Unavailable</span></header>
      <div class="error-message">${htmlEscape(error)}</div>
    </article>`;
  }

  const change = Number(data.changePercent);
  const changeClass = Number.isFinite(change) ? (change > 0 ? "up" : change < 0 ? "down" : "flat") : "flat";
  const detailFields = [
    ["priceLabel", data.priceLabel],
    ["forwardPE", data.forwardPE],
    ["recommendation", data.recommendation],
    ["targetPrice", data.targetPrice],
    ["marketState", data.marketState],
    ["fetchedAt", data.fetchedAt],
  ];

  return `<article class="card">
    <header>
      <div><h2>${htmlEscape(data.symbol ?? symbol)}</h2><div class="name">${htmlEscape(displayValue("name", data.name))}</div></div>
      <span class="session">${htmlEscape(displayValue("priceLabel", data.priceLabel))}</span>
    </header>
    <div class="price-row">
      <span class="price">${htmlEscape(displayValue("price", data.price))}</span>
      <span class="chg ${changeClass}">${htmlEscape(displayValue("changePercent", data.changePercent))}</span>
    </div>
    <div class="sparkline-wrap">${sparklineMarkup(data, data.symbol ?? symbol)}</div>
    <dl class="meta">
      ${detailFields.map(([key, value]) => `<div><dt>${htmlEscape(labelFor(key))}</dt><dd>${htmlEscape(displayValue(key, value))}</dd></div>`).join("\n      ")}
    </dl>
    ${newsMarkup(data)}
  </article>`;
};

/** Shared phone-first CSS: single column only, large type, tall sparklines. */
const reportCss = `
  :root { --bg:#0b0f14; --card:#141a22; --border:#243041; --text:#e8eef6; --muted:#8b9bb0; --up:#3dd68c; --down:#ff6b7a; --accent:#5b9dff; }
  * { box-sizing:border-box; }
  body { margin:0; padding:1.5rem 1.25rem; background:var(--bg); color:var(--text); font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; line-height:1.35; }
  h1 { margin:0 0 .35rem; font-size:1.75rem; font-weight:700; }
  .ts { margin-bottom:1.1rem; color:var(--muted); font-size:1.05rem; }
  .hl { display:grid; gap:.55rem; margin-bottom:1.35rem; font-size:1.05rem; }
  .label, dt, .field-row span:first-child { color:var(--muted); }
  .up { color:var(--up); } .down { color:var(--down); }
  .grid { display:grid; grid-template-columns:1fr; gap:1.5rem; }
  .card { min-width:0; display:flex; flex-direction:column; gap:1rem; padding:1.85rem 1.5rem; background:var(--card); border:1px solid var(--border); border-radius:20px; }
  .card header { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; }
  .card h2 { margin:0; font-size:1.9rem; letter-spacing:.02em; } /* ~30px */
  .name { max-width:260px; overflow:hidden; color:var(--muted); font-size:1.1rem; text-overflow:ellipsis; white-space:nowrap; }
  .session { color:var(--muted); font-size:1rem; text-align:right; text-transform:uppercase; letter-spacing:.04em; }
  .price-row { display:flex; justify-content:space-between; align-items:baseline; gap:.75rem; }
  .price { font-size:2.4rem; font-weight:700; font-variant-numeric:tabular-nums; } /* ~38px */
  .chg { font-size:1.45rem; font-weight:650; font-variant-numeric:tabular-nums; }
  .flat { color:var(--muted); }
  .sparkline-wrap { padding:.55rem 0 .35rem; border-top:1px solid var(--border); border-bottom:1px solid var(--border); }
  .sparkline { display:block; width:100%; height:150px; }
  .sparkline-values { overflow:hidden; color:var(--muted); font-size:.95rem; text-overflow:ellipsis; white-space:nowrap; }
  .sparkline-empty { height:150px; color:var(--muted); font-size:2.2rem; text-align:center; line-height:150px; }
  .meta { display:grid; grid-template-columns:repeat(2,1fr); gap:.85rem 1rem; min-width:0; margin:0; font-size:1.15rem; } /* ~18px */
  .meta > div { min-width:0; }
  dt { font-weight:500; font-size:1rem; } dd { margin:.15rem 0 0; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; font-size:1.2rem; }
  .news { margin-top:.15rem; padding-top:.9rem; border-top:1px solid var(--border); font-size:1.15rem; }
  .news-label { margin-bottom:.35rem; color:var(--muted); font-size:.95rem; text-transform:uppercase; letter-spacing:.04em; }
  .news a { color:var(--accent); text-decoration:none; } .news a:hover { text-decoration:underline; }
  .error-card { border-color:var(--down); } .error-message { color:var(--down); font-size:1.15rem; overflow-wrap:anywhere; }
  footer { margin-top:1.75rem; color:var(--muted); font-size:1.05rem; }
  .page-label { margin:0 0 1rem; color:var(--muted); font-size:1rem; }
`;

const highlightBlock = (results) => {
  const successful = results.filter((result) => !result.error);
  const changes = successful
    .map(({ data }) => ({ symbol: data.symbol, change: Number(data.changePercent) }))
    .filter(({ change }) => Number.isFinite(change));
  const gainers = [...changes].sort((a, b) => b.change - a.change).slice(0, 3);
  const losers = [...changes].sort((a, b) => a.change - b.change).slice(0, 3);
  const changeList = (entries) => entries.map(({ symbol, change }) => `${htmlEscape(symbol)} ${htmlEscape(formatChange(change))}`).join(" · ") || "—";
  return `<div class="hl">
    <div><span class="label">Top gainers:</span> <span class="up">${changeList(gainers)}</span></div>
    <div><span class="label">Top losers:</span> <span class="down">${changeList(losers)}</span></div>
  </div>`;
};

/** Full HTML (desktop archive): single-column, all tiles. */
const reportHtml = ({ results, updatedAt }) => {
  const successful = results.filter((result) => !result.error);
  const failed = results.filter((result) => result.error);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Stock Report — Paul</title>
<style>${reportCss}</style>
</head>
<body>
  <h1>Stock Report — Paul</h1>
  <div class="ts">Updated ${htmlEscape(formatPacific(updatedAt))} (Pacific)</div>
  ${highlightBlock(results)}
  <div class="grid">
    ${results.map(cardMarkup).join("\n    ")}
  </div>
  <footer>${successful.length} tickers loaded · ${failed.length} failed · generated ${htmlEscape(formatPacific(updatedAt))}</footer>
</body>
</html>
`;
};

/**
 * One phone-screen page of HTML for PNG capture.
 * Page 1 includes title + highlights; last page includes footer.
 */
const pageHtml = ({
  results,
  pageResults,
  updatedAt,
  pageIndex,
  pageCount,
  includeHeader,
  includeFooter,
}) => {
  const successful = results.filter((result) => !result.error);
  const failed = results.filter((result) => result.error);
  const label = `Page ${pageIndex + 1} of ${pageCount}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Stock Report — Paul (${label})</title>
<style>${reportCss}</style>
</head>
<body>
  ${includeHeader ? `
  <h1>Stock Report — Paul</h1>
  <div class="ts">Updated ${htmlEscape(formatPacific(updatedAt))} (Pacific)</div>
  ${highlightBlock(results)}
  ` : `<div class="page-label">${htmlEscape(label)}</div>`}
  <div class="grid">
    ${pageResults.map(cardMarkup).join("\n    ")}
  </div>
  ${includeFooter ? `<footer>${successful.length} tickers loaded · ${failed.length} failed · generated ${htmlEscape(formatPacific(updatedAt))} · ${htmlEscape(label)}</footer>` : ""}
</body>
</html>
`;
};

const reportSummary = ({ results, updatedAt }) => {
  const successful = results.filter((result) => !result.error);
  const failed = results.filter((result) => result.error);
  const changes = successful
    .map(({ data }) => ({ symbol: data.symbol, change: Number(data.changePercent) }))
    .filter(({ change }) => Number.isFinite(change));
  const gainers = [...changes].sort((a, b) => b.change - a.change).slice(0, 3);
  const losers = [...changes].sort((a, b) => a.change - b.change).slice(0, 3);
  const withNews = successful.filter(({ data }) => data.newsTitle && data.newsUrl);
  const lines = [
    `Updated ${formatPacific(updatedAt)} (Pacific)`,
    "",
    "Top gainers:",
    ...gainers.map(({ symbol, change }) => `  ${symbol} ${formatChange(change)}`),
    "Top losers:",
    ...losers.map(({ symbol, change }) => `  ${symbol} ${formatChange(change)}`),
    "",
    ...results.map(({ symbol, data, error }) => error
      ? `${symbol} [FAILED: ${error}]`
      : `${symbol} ${formatPrice(data.price)} (${formatChange(data.changePercent)}) [${displayValue("priceLabel", data.priceLabel)}]${data.newsTitle ? ` | news: ${data.newsTitle}` : " | news: —"}`),
    "",
    `${successful.length} tickers loaded; ${failed.length} failed; ${withNews.length} with company-specific news (48h).`,
  ];
  return `${lines.join("\n")}\n`;
};

/** Split watchlist into pages of ~2–3 tiles (never the whole list). */
const chunkResultsForPages = (results) => {
  const pages = [];
  for (let i = 0; i < results.length; i += TARGET_TILES_PER_PAGE) {
    pages.push(results.slice(i, i + TARGET_TILES_PER_PAGE));
  }
  // If the last page has a single orphan and the previous page has room for 3, merge.
  if (pages.length >= 2) {
    const last = pages[pages.length - 1];
    const prev = pages[pages.length - 2];
    if (last.length === 1 && prev.length < MAX_TILES_PER_PAGE) {
      prev.push(...last);
      pages.pop();
    }
  }
  return pages.length ? pages : [[]];
};

/** Render multiple phone-aspect PNG pages (not one ultra-tall image). */
const renderReportPngPages = async ({ results, updatedAt, outDir, baseName }) => {
  const chunks = chunkResultsForPages(results);
  const pageCount = chunks.length;
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--font-render-hinting=none",
    ],
  });

  const pngPaths = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: PHONE_VIEWPORT_WIDTH,
      height: PHONE_VIEWPORT_HEIGHT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    });

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const pageResults = chunks[pageIndex];
      const html = pageHtml({
        results,
        pageResults,
        updatedAt,
        pageIndex,
        pageCount,
        includeHeader: pageIndex === 0,
        includeFooter: pageIndex === pageCount - 1,
      });
      const pngPath = path.join(outDir, `${baseName}-${pageIndex + 1}.png`);
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready.catch(() => {}));

      // Prefer clip to body content height so we don't pad to full viewport.
      const metrics = await page.evaluate(() => {
        const body = document.body;
        const height = Math.ceil(Math.max(
          body.scrollHeight,
          body.offsetHeight,
          document.documentElement.scrollHeight,
        ));
        return { width: document.documentElement.clientWidth, height };
      });

      // Cap extremely tall accidental pages (should not happen with 2 tiles).
      const clipHeight = Math.min(metrics.height, MAX_PAGE_CSS_HEIGHT * 2);
      await page.screenshot({
        path: pngPath,
        type: "png",
        clip: {
          x: 0,
          y: 0,
          width: PHONE_VIEWPORT_WIDTH,
          height: clipHeight,
        },
      });
      pngPaths.push(pngPath);
    }
  } finally {
    await browser.close();
  }
  return pngPaths;
};

const main = async () => {
  const outputPath = path.resolve(process.argv[2] || DEFAULT_OUTPUT);
  const baseName = path.basename(outputPath, path.extname(outputPath));
  const outDir = path.dirname(outputPath);
  const summaryPath = path.join(outDir, `${baseName}-summary.txt`);
  const manifestPath = path.join(outDir, `${baseName}-pages.txt`);
  const legacySinglePng = path.join(outDir, `${baseName}.png`);

  const tickers = await getTickers();
  const updatedAt = new Date();
  const results = await fetchAll(tickers);
  await mkdir(outDir, { recursive: true });

  await Promise.all([
    writeFile(outputPath, reportHtml({ results, updatedAt }), "utf8"),
    writeFile(summaryPath, reportSummary({ results, updatedAt }), "utf8"),
  ]);

  const pngPaths = await renderReportPngPages({ results, updatedAt, outDir, baseName });
  await writeFile(manifestPath, `${pngPaths.join("\n")}\n`, "utf8");

  // Remove legacy single ultra-tall PNG if present so morning routines don't pick it up.
  try {
    await unlink(legacySinglePng);
    console.log(`Removed legacy single PNG ${legacySinglePng}`);
  } catch {
    // ignore missing
  }

  const failures = results.filter((result) => result.error);
  const withNews = results.filter((r) => !r.error && r.data?.newsTitle && r.data?.newsUrl);
  const withoutNews = results.filter((r) => !r.error && !(r.data?.newsTitle && r.data?.newsUrl));
  console.log(`Wrote ${outputPath}`);
  console.log(`Wrote ${summaryPath}`);
  console.log(`Wrote ${manifestPath}`);
  for (const pngPath of pngPaths) console.log(`Wrote ${pngPath}`);
  console.log(`Pages: ${pngPaths.length} (≈${TARGET_TILES_PER_PAGE} tiles each, ${PHONE_VIEWPORT_WIDTH}×${DEVICE_SCALE_FACTOR}x)`);
  console.log(`Loaded ${results.length - failures.length}/${results.length} tickers; ${failures.length} failed.`);
  console.log(`News: ${withNews.map((r) => r.symbol).join(", ") || "(none)"}`);
  console.log(`No news: ${withoutNews.map((r) => r.symbol).join(", ") || "(none)"}`);
  for (const failure of failures) console.error(`${failure.symbol}: ${failure.error}`);
  if (failures.length) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

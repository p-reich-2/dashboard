#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_OUTPUT = "/workspace/stock-report-sample.html";
const API_BASE = process.env.STOCK_API_BASE ?? "http://localhost:3000/api/stocks";
const TICKERS_FILE = new URL("../src/config/tickers.ts", import.meta.url);
const PACIFIC_TIME_ZONE = "America/Los_Angeles";

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

  const width = 240;
  const height = 62;
  const padding = 5;
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
        <polyline points="${points}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="sparkline-values">${htmlEscape(label)}</div>`;
};

const newsMarkup = (data) => {
  if (!data.newsTitle) return `<div class="news">—</div>`;
  if (!data.newsUrl) return `<div class="news">${htmlEscape(data.newsTitle)}</div>`;
  return `<div class="news"><a href="${htmlEscape(data.newsUrl)}" target="_blank" rel="noopener">${htmlEscape(data.newsTitle)}</a></div>`;
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
    <div class="field-row"><span>${htmlEscape(labelFor("newsUrl"))}</span><span>${data.newsUrl ? "available" : "—"}</span></div>
  </article>`;
};

const reportHtml = ({ results, updatedAt }) => {
  const successful = results.filter((result) => !result.error);
  const failed = results.filter((result) => result.error);
  const changes = successful
    .map(({ data }) => ({ symbol: data.symbol, change: Number(data.changePercent) }))
    .filter(({ change }) => Number.isFinite(change));
  const gainers = [...changes].sort((a, b) => b.change - a.change).slice(0, 3);
  const losers = [...changes].sort((a, b) => a.change - b.change).slice(0, 3);
  const changeList = (entries) => entries.map(({ symbol, change }) => `${htmlEscape(symbol)} ${htmlEscape(formatChange(change))}`).join(" · ") || "—";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Stock Report — Paul</title>
<style>
  :root { --bg:#0b0f14; --card:#141a22; --border:#243041; --text:#e8eef6; --muted:#8b9bb0; --up:#3dd68c; --down:#ff6b7a; --accent:#5b9dff; }
  * { box-sizing:border-box; }
  body { margin:0; padding:1.25rem; background:var(--bg); color:var(--text); font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; line-height:1.4; }
  h1 { margin:0 0 .25rem; font-size:1.35rem; }
  .ts { margin-bottom:1rem; color:var(--muted); font-size:.9rem; }
  .hl { display:grid; gap:.5rem; margin-bottom:1.25rem; font-size:.92rem; }
  .label, dt, .field-row span:first-child { color:var(--muted); }
  .up { color:var(--up); } .down { color:var(--down); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:.85rem; }
  .card { display:flex; flex-direction:column; gap:.55rem; padding:.95rem 1rem; background:var(--card); border:1px solid var(--border); border-radius:14px; }
  .card header { display:flex; justify-content:space-between; align-items:flex-start; gap:.75rem; }
  .card h2 { margin:0; font-size:1.1rem; letter-spacing:.02em; }
  .name { max-width:190px; overflow:hidden; color:var(--muted); font-size:.75rem; text-overflow:ellipsis; white-space:nowrap; }
  .session { color:var(--muted); font-size:.75rem; text-align:right; text-transform:uppercase; letter-spacing:.04em; }
  .price-row { display:flex; justify-content:space-between; align-items:baseline; }
  .price { font-size:1.35rem; font-weight:650; font-variant-numeric:tabular-nums; }
  .chg { font-weight:600; font-variant-numeric:tabular-nums; }
  .flat { color:var(--muted); }
  .sparkline-wrap { padding:.25rem 0 .1rem; border-top:1px solid var(--border); border-bottom:1px solid var(--border); }
  .sparkline { display:block; width:100%; height:62px; }
  .sparkline-values { overflow:hidden; color:var(--muted); font-size:.68rem; text-overflow:ellipsis; white-space:nowrap; }
  .sparkline-empty { height:62px; color:var(--muted); font-size:1.5rem; text-align:center; line-height:62px; }
  .meta { display:grid; grid-template-columns:repeat(2,1fr); gap:.45rem .7rem; margin:0; font-size:.78rem; }
  dt { font-weight:500; } dd { margin:.1rem 0 0; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
  .news { min-height:2.4em; margin-top:.1rem; padding-top:.55rem; border-top:1px solid var(--border); color:var(--muted); font-size:.8rem; }
  .news a { color:var(--accent); text-decoration:none; } .news a:hover { text-decoration:underline; }
  .field-row { display:flex; justify-content:space-between; gap:.75rem; color:var(--muted); font-size:.72rem; }
  .error-card { border-color:var(--down); } .error-message { color:var(--down); font-size:.85rem; overflow-wrap:anywhere; }
  footer { margin-top:1.5rem; color:var(--muted); font-size:.8rem; }
</style>
</head>
<body>
  <h1>Stock Report — Paul</h1>
  <div class="ts">Updated ${htmlEscape(formatPacific(updatedAt))} (Pacific)</div>
  <div class="hl">
    <div><span class="label">Top gainers:</span> <span class="up">${changeList(gainers)}</span></div>
    <div><span class="label">Top losers:</span> <span class="down">${changeList(losers)}</span></div>
  </div>
  <div class="grid">
    ${results.map(cardMarkup).join("\n    ")}
  </div>
  <footer>${successful.length} tickers loaded · ${failed.length} failed · generated ${htmlEscape(formatPacific(updatedAt))}</footer>
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
      : `${symbol} ${formatPrice(data.price)} (${formatChange(data.changePercent)}) [${displayValue("priceLabel", data.priceLabel)}]`),
    "",
    `${successful.length} tickers loaded; ${failed.length} failed.`,
  ];
  return `${lines.join("\n")}\n`;
};

const main = async () => {
  const outputPath = path.resolve(process.argv[2] || DEFAULT_OUTPUT);
  const summaryPath = path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}-summary.txt`);
  const tickers = await getTickers();
  const updatedAt = new Date();
  const results = await fetchAll(tickers);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await Promise.all([
    writeFile(outputPath, reportHtml({ results, updatedAt }), "utf8"),
    writeFile(summaryPath, reportSummary({ results, updatedAt }), "utf8"),
  ]);

  const failures = results.filter((result) => result.error);
  console.log(`Wrote ${outputPath}`);
  console.log(`Wrote ${summaryPath}`);
  console.log(`Loaded ${results.length - failures.length}/${results.length} tickers; ${failures.length} failed.`);
  for (const failure of failures) console.error(`${failure.symbol}: ${failure.error}`);
  if (failures.length) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

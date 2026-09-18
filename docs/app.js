import { TICKERS, TICKER_ALIASES } from "./tickers.js";

const NEWS_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const NEWS_FETCH_COUNT = 12;
const FETCH_TIMEOUT_MS = 28000;
const MAX_ATTEMPTS = 3;
const CHART_CONCURRENCY = 2;
const ENRICH_CONCURRENCY = 1;
const RETRY_BASE_MS = 700;

/** @typedef {{ loading: boolean, error: string|null, data: object|null, enriching?: boolean }} TileState */

const AMBIGUOUS_TICKERS = new Set([
  "NOW",
  "ALL",
  "ONE",
  "ARE",
  "OUT",
  "FOR",
  "NEW",
  "LOW",
  "HAS",
  "ANY",
  "BIG",
  "SEE",
]);

const GENERIC_HEADLINE_RE =
  /\b(stock market today|markets?\s+(today|live|wrap|recap|update|open)|live coverage|what to watch|stocks?\s+to\s+watch|midday\s+movers|top\s+(stock\s+)?(gainers|losers|movers)|wall st(?:reet)?\s+set to|most active stocks|bc-most active)\b/i;

const gridEl = document.getElementById("grid");
const lastUpdatedEl = document.getElementById("last-updated");
const loadingCountEl = document.getElementById("loading-count");
const refreshBtn = document.getElementById("refresh-btn");

/** @type {Record<string, TileState>} */
const tiles = {};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtPrice(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtPE(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(1);
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function formatPacific(iso) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "raw" in v) {
    const raw = v.raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return null;
}

function formatRecommendation(key) {
  if (!key || String(key).toLowerCase() === "none") return null;
  const map = {
    strong_buy: "Strong Buy",
    buy: "Buy",
    hold: "Hold",
    underperform: "Underperform",
    sell: "Sell",
    strong_sell: "Strong Sell",
  };
  const k = String(key).toLowerCase();
  return map[k] ?? String(key).replace(/_/g, " ");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run async tasks with a fixed concurrency limit.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} worker
 */
async function mapPool(items, limit, worker) {
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * @param {string} text
 * @returns {any}
 */
function parseJsonPayload(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error("Empty response");

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // jina markdown / surrounding text: pull first JSON object
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } else {
      throw new Error("Invalid JSON");
    }
  }

  if (parsed && typeof parsed === "object") {
    if ("chart" in parsed || "news" in parsed || "quoteSummary" in parsed) {
      return parsed;
    }
    // allorigins /get
    if (typeof parsed.contents === "string") {
      if (!parsed.contents.trim()) throw new Error("Proxy empty contents");
      return JSON.parse(parsed.contents);
    }
    // jina reader JSON API
    if (parsed.data && typeof parsed.data.content === "string") {
      const content = parsed.data.content.trim();
      if (!content) throw new Error("Jina empty content");
      return JSON.parse(content);
    }
    if (typeof parsed.content === "string" && parsed.content.trim().startsWith("{")) {
      return JSON.parse(parsed.content);
    }
  }
  return parsed;
}

/**
 * Build candidate URLs: direct Yahoo first, then CORS proxies.
 * @param {string} yahooUrl
 * @returns {string[]}
 */
function proxyCandidates(yahooUrl) {
  const enc = encodeURIComponent(yahooUrl);
  return [
    yahooUrl,
    `https://r.jina.ai/${yahooUrl}`,
    `https://api.allorigins.win/get?url=${enc}`,
    `https://api.allorigins.win/raw?url=${enc}`,
    `https://api.codetabs.com/v1/proxy?quest=${enc}`,
  ];
}

/**
 * Fetch JSON from Yahoo via direct + proxy fallbacks, with timeout and retries.
 * @param {string} yahooUrl
 * @param {{ attempts?: number }} [opts]
 */
async function fetchJson(yahooUrl, opts = {}) {
  const attempts = opts.attempts ?? MAX_ATTEMPTS;
  const candidates = proxyCandidates(yahooUrl);
  const errors = [];

  for (let attempt = 0; attempt < attempts; attempt++) {
    // Rotate start index so retries try a different order after failures
    const order = candidates
      .slice(attempt % candidates.length)
      .concat(candidates.slice(0, attempt % candidates.length));

    for (const url of order) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const text = await res.text();
        if (!text || !text.trim()) throw new Error("Empty body");
        return parseJsonPayload(text);
      } catch (err) {
        const msg =
          err?.name === "AbortError"
            ? "timeout"
            : err instanceof Error
              ? err.message
              : String(err);
        const host = (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return "fetch";
          }
        })();
        errors.push(`${host}: ${msg}`);
      } finally {
        clearTimeout(timer);
      }
    }
    if (attempt < attempts - 1) {
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 400);
    }
  }

  throw new Error(errors.slice(-4).join(" · ") || "All fetch strategies failed");
}

function pickPrice(meta) {
  const now = Math.floor(Date.now() / 1000);
  const periods = meta.currentTradingPeriod;
  const regular = meta.regularMarketPrice ?? null;
  const fullday = meta.fulldayPrice ?? null;

  const inPre =
    periods?.pre != null && now >= periods.pre.start && now < periods.pre.end;
  const inRegular =
    periods?.regular != null &&
    now >= periods.regular.start &&
    now < periods.regular.end;
  const inPost =
    periods?.post != null &&
    now >= periods.post.start &&
    now < periods.post.end;
  const afterPost =
    periods?.post != null && now >= periods.post.end && !inPre && !inRegular;

  if (inPre && fullday != null) return { price: fullday, label: "Premarket" };
  if ((inPost || afterPost) && fullday != null)
    return { price: fullday, label: "After-hours" };
  if (inRegular && regular != null) return { price: regular, label: "Market" };
  if (regular != null) return { price: regular, label: "Last close" };
  if (fullday != null) return { price: fullday, label: "Last close" };
  return { price: null, label: "Last close" };
}

async function fetchChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=5d&interval=1d&includePrePost=true`;
  const json = await fetchJson(url);
  const result = json?.chart?.result?.[0];
  if (!result) {
    throw new Error(json?.chart?.error?.description ?? "No chart data");
  }
  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter(
    (c) => typeof c === "number" && Number.isFinite(c)
  );

  // Optional intraday meta for pre/post labels — never fail the tile
  try {
    const dayUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?range=1d&interval=5m&includePrePost=true`;
    const dayJson = await fetchJson(dayUrl, { attempts: 1 });
    const dayMeta = dayJson?.chart?.result?.[0]?.meta;
    if (dayMeta) result.meta = { ...result.meta, ...dayMeta };
  } catch {
    // keep 5d meta
  }

  return { meta: result.meta, sparkline: closes.slice(-5) };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function companyNamePhrases(name) {
  if (!name) return [];
  const cleaned = name
    .replace(
      /,?\s+(Inc\.?|Incorporated|Corp\.?|Corporation|Ltd\.?|Limited|Co\.?|Company|Holdings|Holding|Group|PLC|N\.V\.|S\.A\.|Class\s+[A-Z]|Ordinary Shares|Common Stock)\b\.?/gi,
      ""
    )
    .replace(/\.com\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 2) return [];
  const phrases = [cleaned];
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length > 1 && parts[0].length >= 4) phrases.push(parts[0]);
  return phrases;
}

function newsMatchTerms(symbol, companyName) {
  const terms = new Set();
  terms.add(symbol);
  for (const phrase of companyNamePhrases(companyName)) terms.add(phrase);
  for (const alias of TICKER_ALIASES[symbol] ?? []) terms.add(alias);
  return Array.from(terms).filter((t) => t.length >= 2);
}

function textMentionsCompany(text, symbol, companyName) {
  if (!text.trim()) return false;
  for (const term of newsMatchTerms(symbol, companyName)) {
    if (term.toUpperCase() === symbol && AMBIGUOUS_TICKERS.has(symbol)) {
      const strict = new RegExp(
        `(?:\\$${escapeRegExp(symbol)}\\b|\\(${escapeRegExp(
          symbol
        )}\\)|\\b${escapeRegExp(symbol)}\\s+(?:stock|shares|equity)\\b)`,
        "i"
      );
      if (strict.test(text)) return true;
      continue;
    }
    const pattern =
      term.toUpperCase() === symbol
        ? `(?:\\$)?\\b${escapeRegExp(term)}\\b`
        : `\\b${escapeRegExp(term)}\\b`;
    if (new RegExp(pattern, "i").test(text)) return true;
  }
  return false;
}

function isRecentNews(item, nowMs) {
  const published = item.providerPublishTime;
  if (typeof published !== "number" || !Number.isFinite(published)) return false;
  const publishedMs = published > 1e12 ? published : published * 1000;
  const age = nowMs - publishedMs;
  return age >= 0 && age <= NEWS_MAX_AGE_MS;
}

function isGenericMarketHeadline(title) {
  return GENERIC_HEADLINE_RE.test(title);
}

function isMultiTickerListHeadline(title) {
  return /^[A-Z]{1,5}(?:\s*,\s*[A-Z]{1,5}){2,}\b/.test(title.trim());
}

function isAboutCompany(item, symbol, companyName) {
  const title = item.title ?? "";
  const summary = item.summary ?? "";
  if (isGenericMarketHeadline(title) || isMultiTickerListHeadline(title))
    return false;
  return (
    textMentionsCompany(title, symbol, companyName) ||
    textMentionsCompany(summary, symbol, companyName)
  );
}

async function fetchNewsCandidates(symbol) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
    symbol
  )}&newsCount=${NEWS_FETCH_COUNT}&quotesCount=0`;
  const json = await fetchJson(url, { attempts: 2 });
  return json.news ?? [];
}

function pickRelevantNews(candidates, symbol, companyName) {
  const nowMs = Date.now();
  const recent = candidates.filter((n) => isRecentNews(n, nowMs));
  const relevant = recent.filter((n) => isAboutCompany(n, symbol, companyName));
  const picked = relevant.find((n) => n.title && n.link) ?? null;
  if (picked) return { title: picked.title ?? null, url: picked.link ?? null };
  return { title: null, url: null };
}

async function fetchFundamentals(symbol) {
  const empty = { forwardPE: null, recommendation: null, targetPrice: null };
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    symbol
  )}?modules=defaultKeyStatistics,financialData`;
  try {
    const json = await fetchJson(url, { attempts: 1 });
    const result = json?.quoteSummary?.result?.[0];
    if (!result) return empty;
    return {
      forwardPE: num(result.defaultKeyStatistics?.forwardPE),
      recommendation: formatRecommendation(
        result.financialData?.recommendationKey ?? null
      ),
      targetPrice: num(result.financialData?.targetMeanPrice),
    };
  } catch {
    return empty;
  }
}

/**
 * Critical path: chart only. News/fundamentals enrich later.
 * @param {string} symbol
 */
async function fetchChartData(symbol) {
  const sym = symbol.trim().toUpperCase();
  const { meta, sparkline } = await fetchChart(sym);
  const { price, label } = pickPrice(meta);
  const companyName = meta.shortName || meta.longName || null;
  return {
    symbol: sym,
    name: companyName,
    price,
    priceLabel: label,
    changePercent: num(meta.regularMarketChangePercent),
    forwardPE: null,
    recommendation: null,
    targetPrice: null,
    newsTitle: null,
    newsUrl: null,
    sparkline,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Optional enrichment — never throws to caller.
 * @param {object} data
 */
async function enrichStockData(data) {
  const sym = data.symbol;
  const [newsSettled, fundSettled] = await Promise.allSettled([
    fetchNewsCandidates(sym),
    fetchFundamentals(sym),
  ]);

  const news =
    newsSettled.status === "fulfilled"
      ? pickRelevantNews(newsSettled.value, sym, data.name)
      : { title: null, url: null };
  const funds =
    fundSettled.status === "fulfilled"
      ? fundSettled.value
      : { forwardPE: null, recommendation: null, targetPrice: null };

  return {
    ...data,
    forwardPE: funds.forwardPE,
    recommendation: funds.recommendation,
    targetPrice: funds.targetPrice,
    newsTitle: news.title,
    newsUrl: news.url,
    fetchedAt: new Date().toISOString(),
  };
}

function sparklineSvg(data, positive) {
  const width = 120;
  const height = 36;
  if (!data.length) {
    return `<div style="width:${width}px;height:${height}px;color:var(--muted);font-size:10px;display:flex;align-items:center">—</div>`;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 2;
  const points = data
    .map((v, i) => {
      const x = pad + (i / Math.max(data.length - 1, 1)) * (width - pad * 2);
      const y = height - pad - ((v - min) / range) * (height - pad * 2);
      return `${x},${y}`;
    })
    .join(" ");
  const stroke = positive ? "#34d399" : "#f87171";
  const lastX =
    pad +
    ((data.length - 1) / Math.max(data.length - 1, 1)) * (width - pad * 2);
  const lastY =
    height - pad - ((data[data.length - 1] - min) / range) * (height - pad * 2);
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
    <polyline fill="none" stroke="${stroke}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" points="${points}" />
    <circle cx="${lastX}" cy="${lastY}" r="2.25" fill="${stroke}" />
  </svg>`;
}

function renderSkeleton(symbol) {
  return `<article class="tile skeleton" data-symbol="${escapeHtml(symbol)}">
    <div class="tile-header">
      <div class="skel" style="height:1.5rem;width:4rem"></div>
      <div class="skel" style="height:1.25rem;width:3.5rem"></div>
    </div>
    <div class="skel" style="height:2rem;width:7rem;margin-bottom:0.25rem"></div>
    <div class="skel dim" style="height:0.75rem;width:5rem"></div>
    <div class="skel dim" style="height:0.75rem;width:100%"></div>
    <div class="skel dim" style="height:0.75rem;width:75%"></div>
    <div class="skel dim" style="height:2.25rem;width:7rem;margin-top:auto"></div>
  </article>`;
}

function renderError(symbol, error) {
  return `<article class="tile error" data-symbol="${escapeHtml(symbol)}">
    <h2 class="symbol">${escapeHtml(symbol)}</h2>
    <p class="error-msg">Failed to load</p>
    <p class="error-detail">${escapeHtml(error || "Unknown error")}</p>
    <button type="button" class="retry-btn" data-retry="${escapeHtml(
      symbol
    )}">Retry</button>
  </article>`;
}

function renderTile(data) {
  const up = (data.changePercent ?? 0) >= 0;
  const pctClass = up ? "up" : "down";
  const hasNews = Boolean(data.newsTitle && data.newsUrl);
  const nameHtml = data.name
    ? `<p class="name" title="${escapeHtml(data.name)}">${escapeHtml(
        data.name
      )}</p>`
    : "";
  const newsHtml = hasNews
    ? `<div class="news">
        <div class="news-label">Latest news</div>
        <a href="${escapeHtml(data.newsUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
          data.newsTitle
        )}</a>
      </div>`
    : "";

  return `<article class="tile" data-symbol="${escapeHtml(data.symbol)}">
    <header class="tile-header">
      <div>
        <h2 class="symbol">${escapeHtml(data.symbol)}</h2>
        ${nameHtml}
      </div>
      <span class="pct ${pctClass}">${fmtPct(data.changePercent)}</span>
    </header>
    <div>
      <div class="price">${fmtPrice(data.price)}</div>
      <div class="price-label">${escapeHtml(data.priceLabel)}</div>
    </div>
    <dl class="stats">
      <div>
        <dt>Forward PE</dt>
        <dd>${fmtPE(data.forwardPE)}</dd>
      </div>
      <div>
        <dt>Analyst</dt>
        <dd>${escapeHtml(data.recommendation ?? "—")}</dd>
      </div>
      <div class="span-2">
        <dt>Price target</dt>
        <dd>${fmtPrice(data.targetPrice)}</dd>
      </div>
    </dl>
    <div class="spark-wrap">
      <div class="spark-label">5-day trend</div>
      ${sparklineSvg(data.sparkline || [], up)}
    </div>
    ${newsHtml}
  </article>`;
}

function updateHeader() {
  const loadingCount = Object.values(tiles).filter(
    (t) => t.loading || t.enriching
  ).length;
  const fetchedAts = Object.values(tiles)
    .map((t) => t.data?.fetchedAt)
    .filter(Boolean)
    .sort();
  const latest = fetchedAts.length ? fetchedAts[fetchedAts.length - 1] : null;

  if (loadingCount > 0 && !latest) {
    lastUpdatedEl.textContent = "Loading…";
  } else {
    lastUpdatedEl.textContent = formatPacific(latest);
  }

  if (loadingCount > 0) {
    loadingCountEl.hidden = false;
    loadingCountEl.textContent = `· ${loadingCount} loading`;
  } else {
    loadingCountEl.hidden = true;
    loadingCountEl.textContent = "";
  }

  refreshBtn.disabled = Object.values(tiles).some((t) => t.loading);
}

function paintTile(symbol) {
  const state = tiles[symbol];
  const existing = gridEl.querySelector(`[data-symbol="${symbol}"]`);
  let html;
  if (state.loading && !state.data) html = renderSkeleton(symbol);
  else if (state.error && !state.data) html = renderError(symbol, state.error);
  else if (state.data) html = renderTile(state.data);
  else html = renderSkeleton(symbol);

  const tmp = document.createElement("div");
  tmp.innerHTML = html.trim();
  const node = tmp.firstElementChild;
  if (existing) existing.replaceWith(node);
  else gridEl.appendChild(node);
}

function initGrid() {
  gridEl.innerHTML = "";
  for (const symbol of TICKERS) {
    tiles[symbol] = { loading: true, error: null, data: null, enriching: false };
    paintTile(symbol);
  }
  updateHeader();
}

async function enrichOne(symbol) {
  const state = tiles[symbol];
  if (!state?.data) return;
  tiles[symbol] = { ...state, enriching: true };
  updateHeader();
  try {
    const enriched = await enrichStockData(state.data);
    // Only apply if chart data for this symbol is still current
    if (tiles[symbol]?.data?.symbol === symbol) {
      tiles[symbol] = {
        loading: false,
        error: null,
        data: enriched,
        enriching: false,
      };
      paintTile(symbol);
    }
  } catch {
    if (tiles[symbol]) {
      tiles[symbol] = { ...tiles[symbol], enriching: false };
    }
  }
  updateHeader();
}

async function loadOne(symbol) {
  tiles[symbol] = {
    loading: true,
    error: null,
    data: tiles[symbol]?.data ?? null,
    enriching: false,
  };
  if (!tiles[symbol].data) paintTile(symbol);
  updateHeader();

  try {
    const data = await fetchChartData(symbol);
    tiles[symbol] = { loading: false, error: null, data, enriching: false };
    paintTile(symbol);
    updateHeader();
    // Enrich in background without failing the tile
    enrichOne(symbol);
  } catch (err) {
    tiles[symbol] = {
      loading: false,
      error: err instanceof Error ? err.message : "Network error",
      data: null,
      enriching: false,
    };
    paintTile(symbol);
    updateHeader();
  }
}

async function loadAll() {
  initGrid();
  const enrichQueue = [];

  await mapPool(TICKERS, CHART_CONCURRENCY, async (symbol) => {
    try {
      const data = await fetchChartData(symbol);
      tiles[symbol] = { loading: false, error: null, data, enriching: false };
      paintTile(symbol);
      updateHeader();
      enrichQueue.push(symbol);
    } catch (err) {
      tiles[symbol] = {
        loading: false,
        error: err instanceof Error ? err.message : "Network error",
        data: null,
        enriching: false,
      };
      paintTile(symbol);
      updateHeader();
    }
    // Small gap to ease proxy rate limits
    await sleep(250);
  });

  updateHeader();

  // News / fundamentals after charts, one at a time
  await mapPool(enrichQueue, ENRICH_CONCURRENCY, async (symbol) => {
    await enrichOne(symbol);
    await sleep(350);
  });
  updateHeader();
}

refreshBtn.addEventListener("click", () => {
  loadAll();
});

gridEl.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-retry]");
  if (!btn) return;
  const symbol = btn.getAttribute("data-retry");
  if (symbol) loadOne(symbol);
});

loadAll();

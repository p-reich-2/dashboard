import { TICKERS, TICKER_ALIASES } from "./tickers.js";

const NEWS_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const NEWS_FETCH_COUNT = 12;
const CORS_PROXY = "https://api.allorigins.win/raw?url=";

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

/** @type {Record<string, { loading: boolean, error: string|null, data: object|null }>} */
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

async function fetchJson(url) {
  const tryOnce = async (u) => {
    const res = await fetch(u, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON");
    }
  };

  try {
    return await tryOnce(url);
  } catch (directErr) {
    const proxied = CORS_PROXY + encodeURIComponent(url);
    try {
      return await tryOnce(proxied);
    } catch (proxyErr) {
      const msg =
        proxyErr instanceof Error ? proxyErr.message : "Proxy fetch failed";
      const direct =
        directErr instanceof Error ? directErr.message : "Direct fetch failed";
      throw new Error(`${direct}; proxy: ${msg}`);
    }
  }
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

  try {
    const dayUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?range=1d&interval=5m&includePrePost=true`;
    const dayJson = await fetchJson(dayUrl);
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
  const json = await fetchJson(url);
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
    const json = await fetchJson(url);
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

async function fetchStockData(symbol) {
  const sym = symbol.trim().toUpperCase();
  const [chartSettled, newsSettled, fundSettled] = await Promise.allSettled([
    fetchChart(sym),
    fetchNewsCandidates(sym),
    fetchFundamentals(sym),
  ]);

  if (chartSettled.status === "rejected") {
    throw new Error(
      chartSettled.reason instanceof Error
        ? chartSettled.reason.message
        : `Failed to load ${sym}`
    );
  }

  const { meta, sparkline } = chartSettled.value;
  const { price, label } = pickPrice(meta);
  const companyName = meta.shortName || meta.longName || null;

  const news =
    newsSettled.status === "fulfilled"
      ? pickRelevantNews(newsSettled.value, sym, companyName)
      : { title: null, url: null };
  const funds =
    fundSettled.status === "fulfilled"
      ? fundSettled.value
      : { forwardPE: null, recommendation: null, targetPrice: null };

  return {
    symbol: sym,
    name: companyName,
    price,
    priceLabel: label,
    changePercent: num(meta.regularMarketChangePercent),
    forwardPE: funds.forwardPE,
    recommendation: funds.recommendation,
    targetPrice: funds.targetPrice,
    newsTitle: news.title,
    newsUrl: news.url,
    sparkline,
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
  const loadingCount = Object.values(tiles).filter((t) => t.loading).length;
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

  refreshBtn.disabled = loadingCount > 0;
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
    tiles[symbol] = { loading: true, error: null, data: null };
    paintTile(symbol);
  }
  updateHeader();
}

async function loadAll() {
  initGrid();
  await Promise.all(
    TICKERS.map(async (symbol) => {
      try {
        const data = await fetchStockData(symbol);
        tiles[symbol] = { loading: false, error: null, data };
      } catch (err) {
        tiles[symbol] = {
          loading: false,
          error: err instanceof Error ? err.message : "Network error",
          data: null,
        };
      }
      paintTile(symbol);
      updateHeader();
    })
  );
  updateHeader();
}

refreshBtn.addEventListener("click", () => {
  loadAll();
});

loadAll();

import { execFile } from "child_process";
import { promisify } from "util";
import type { PriceLabel, StockData } from "./types";

const execFileAsync = promisify(execFile);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const NEWS_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const NEWS_FETCH_COUNT = 12;

/** Extra title aliases when Yahoo shortName alone is too narrow or awkward. */
const TICKER_ALIASES: Record<string, string[]> = {
  GOOGL: ["Google", "Alphabet"],
  GOOG: ["Google", "Alphabet"],
  META: ["Facebook", "Meta Platforms"],
  BRK: ["Berkshire"],
  "BRK-B": ["Berkshire"],
  "BRK-A": ["Berkshire"],
  TSLA: ["Tesla"],
  MSFT: ["Microsoft"],
  AMZN: ["Amazon"],
  NVDA: ["Nvidia", "NVIDIA"],
  AMD: ["Advanced Micro Devices"],
  PLTR: ["Palantir"],
  IBIT: ["iShares Bitcoin Trust", "Bitcoin Trust"],
  CELH: ["Celsius"],
  CRSP: ["CRISPR", "CRISPR Therapeutics"],
  LMND: ["Lemonade"],
  IONQ: ["IonQ"],
  RDW: ["Redwire"],
  HII: ["Huntington Ingalls"],
  NOW: ["ServiceNow"],
  BMNR: ["BitMine"],
};

async function yahooJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

/** Yahoo quote HTML sends huge Link headers; curl avoids Node/undici limits. */
async function fetchHtml(url: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "curl",
    [
      "-sS",
      "-L",
      "--max-time",
      "20",
      "-A",
      UA,
      "-H",
      "Accept: text/html",
      url,
    ],
    {
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    }
  );
  return stdout;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "raw" in (v as object)) {
    const raw = (v as { raw: unknown }).raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return null;
}

function formatRecommendation(key: string | undefined | null): string | null {
  if (!key || key.toLowerCase() === "none") return null;
  const map: Record<string, string> = {
    strong_buy: "Strong Buy",
    buy: "Buy",
    hold: "Hold",
    underperform: "Underperform",
    sell: "Sell",
    strong_sell: "Strong Sell",
  };
  return map[key.toLowerCase()] ?? key.replace(/_/g, " ");
}

interface ChartMeta {
  currency?: string;
  symbol?: string;
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  fulldayPrice?: number;
  fulldayChangePercent?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  shortName?: string;
  longName?: string;
  hasPrePostMarketData?: boolean;
  regularMarketTime?: number;
  currentTradingPeriod?: {
    pre?: { start: number; end: number };
    regular?: { start: number; end: number };
    post?: { start: number; end: number };
  };
}

function pickPrice(meta: ChartMeta): { price: number | null; label: PriceLabel } {
  const now = Math.floor(Date.now() / 1000);
  const periods = meta.currentTradingPeriod;
  const regular = meta.regularMarketPrice ?? null;
  const fullday = meta.fulldayPrice ?? null;

  const inPre =
    periods?.pre != null &&
    now >= periods.pre.start &&
    now < periods.pre.end;
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

  if (inPre && fullday != null) {
    return { price: fullday, label: "Premarket" };
  }
  if ((inPost || afterPost) && fullday != null) {
    return { price: fullday, label: "After-hours" };
  }
  if (inRegular && regular != null) {
    return { price: regular, label: "Market" };
  }
  if (regular != null) {
    return { price: regular, label: "Last close" };
  }
  if (fullday != null) {
    return { price: fullday, label: "Last close" };
  }
  return { price: null, label: "Last close" };
}

async function fetchChart(symbol: string): Promise<{
  meta: ChartMeta;
  sparkline: number[];
}> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=5d&interval=1d&includePrePost=true`;
  const json = (await yahooJson(url)) as {
    chart?: {
      result?: Array<{
        meta: ChartMeta;
        indicators?: { quote?: Array<{ close?: Array<number | null> }> };
      }>;
      error?: { description?: string };
    };
  };
  const result = json.chart?.result?.[0];
  if (!result) {
    throw new Error(json.chart?.error?.description ?? "No chart data");
  }
  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter(
    (c): c is number => typeof c === "number" && Number.isFinite(c)
  );

  try {
    const dayUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?range=1d&interval=5m&includePrePost=true`;
    const dayJson = (await yahooJson(dayUrl)) as {
      chart?: { result?: Array<{ meta: ChartMeta }> };
    };
    const dayMeta = dayJson.chart?.result?.[0]?.meta;
    if (dayMeta) {
      result.meta = { ...result.meta, ...dayMeta };
    }
  } catch {
    // keep 5d meta
  }

  return { meta: result.meta, sparkline: closes.slice(-5) };
}

interface YahooNewsItem {
  title?: string;
  link?: string;
  publisher?: string;
  providerPublishTime?: number;
  relatedTickers?: string[];
  summary?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip legal suffixes so "Tesla, Inc." → "Tesla" for title matching. */
function companyNamePhrases(name: string | null | undefined): string[] {
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
  if (parts.length > 1 && parts[0].length >= 4) {
    phrases.push(parts[0]);
  }
  return phrases;
}

function newsMatchTerms(
  symbol: string,
  companyName: string | null | undefined
): string[] {
  const terms = new Set<string>();
  terms.add(symbol);
  for (const phrase of companyNamePhrases(companyName)) {
    terms.add(phrase);
  }
  for (const alias of TICKER_ALIASES[symbol] ?? []) {
    terms.add(alias);
  }
  // Drop ultra-short / generic tokens that would match unrelated headlines.
  return Array.from(terms).filter((t) => t.length >= 2);
}

/** Tickers that are common English words — bare word-boundary ticker matches are too noisy. */
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

function textMentionsCompany(
  text: string,
  symbol: string,
  companyName: string | null | undefined
): boolean {
  if (!text.trim()) return false;
  for (const term of newsMatchTerms(symbol, companyName)) {
    if (term.toUpperCase() === symbol && AMBIGUOUS_TICKERS.has(symbol)) {
      // Require $NOW, (NOW), or "NOW stock/shares" — not bare English "now".
      const strict = new RegExp(
        `(?:\\$${escapeRegExp(symbol)}\\b|\\(${escapeRegExp(symbol)}\\)|\\b${escapeRegExp(symbol)}\\s+(?:stock|shares|equity)\\b)`,
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

function isRecentNews(item: YahooNewsItem, nowMs: number): boolean {
  const published = item.providerPublishTime;
  if (typeof published !== "number" || !Number.isFinite(published)) return false;
  // Yahoo search uses unix seconds; tolerate ms if ever seen.
  const publishedMs = published > 1e12 ? published : published * 1000;
  const age = nowMs - publishedMs;
  return age >= 0 && age <= NEWS_MAX_AGE_MS;
}

/** Market digests / wraps that casually list many tickers — skip even if name appears. */
const GENERIC_HEADLINE_RE =
  /\b(stock market today|markets?\s+(today|live|wrap|recap|update|open)|live coverage|what to watch|stocks?\s+to\s+watch|midday\s+movers|top\s+(stock\s+)?(gainers|losers|movers)|wall st(?:reet)?\s+set to|most active stocks|bc-most active)\b/i;

function isGenericMarketHeadline(title: string): boolean {
  return GENERIC_HEADLINE_RE.test(title);
}

/** "NOW, INTU, ADBE, CRM Stocks Surge..." style multi-name list leads. */
function isMultiTickerListHeadline(title: string): boolean {
  return /^[A-Z]{1,5}(?:\s*,\s*[A-Z]{1,5}){2,}\b/.test(title.trim());
}

function isAboutCompany(
  item: YahooNewsItem,
  symbol: string,
  companyName: string | null | undefined
): boolean {
  const title = item.title ?? "";
  const summary = item.summary ?? "";
  if (isGenericMarketHeadline(title) || isMultiTickerListHeadline(title)) return false;
  // Strict: title or summary must name the company/ticker. relatedTickers alone is not enough.
  return (
    textMentionsCompany(title, symbol, companyName) ||
    textMentionsCompany(summary, symbol, companyName)
  );
}

async function fetchNewsCandidates(symbol: string): Promise<YahooNewsItem[]> {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
    symbol
  )}&newsCount=${NEWS_FETCH_COUNT}&quotesCount=0`;
  const json = (await yahooJson(url)) as { news?: YahooNewsItem[] };
  return json.news ?? [];
}

function pickRelevantNews(
  candidates: YahooNewsItem[],
  symbol: string,
  companyName: string | null | undefined
): { title: string | null; url: string | null } {
  const nowMs = Date.now();
  const recent = candidates.filter((n) => isRecentNews(n, nowMs));
  const relevant = recent.filter((n) => isAboutCompany(n, symbol, companyName));

  const picked = relevant.find((n) => n.title && n.link) ?? null;

  if (picked) {
    console.log(
      `[news] ${symbol}: kept "${picked.title}" (${relevant.length}/${candidates.length} candidates passed filters)`
    );
    return { title: picked.title ?? null, url: picked.link ?? null };
  }

  console.log(
    `[news] ${symbol}: none (candidates=${candidates.length}, recent48h=${recent.length}, aboutCompany=0)`
  );
  return { title: null, url: null };
}

async function fetchFundamentals(symbol: string): Promise<{
  forwardPE: number | null;
  recommendation: string | null;
  targetPrice: number | null;
}> {
  const empty = {
    forwardPE: null,
    recommendation: null,
    targetPrice: null,
  };
  try {
    const html = await fetchHtml(
      `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`
    );
    if (!html || html.length < 1000) return empty;

    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `<script type="application/json" data-sveltekit-fetched data-url="https://query1\\.finance\\.yahoo\\.com/v10/finance/quoteSummary/${escaped}[^"]*"[^>]*>([\\s\\S]*?)</script>`,
      "i"
    );
    let m = html.match(re);
    if (!m) {
      m = html.match(
        /<script type="application\/json" data-sveltekit-fetched data-url="https:\/\/query1\.finance\.yahoo\.com\/v10\/finance\/quoteSummary\/[^"]*"[^>]*>([\s\S]*?)<\/script>/i
      );
    }
    if (!m) return empty;

    const wrapper = JSON.parse(m[1]) as {
      body?: string | Record<string, unknown>;
    };
    let body = wrapper.body;
    if (typeof body === "string") body = JSON.parse(body);
    const result = (
      body as {
        quoteSummary?: {
          result?: Array<{
            financialData?: {
              recommendationKey?: string;
              targetMeanPrice?: unknown;
            };
            defaultKeyStatistics?: { forwardPE?: unknown };
          }>;
        };
      }
    )?.quoteSummary?.result?.[0];

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

/** Simple concurrency gate so we don't stampede Yahoo HTML pages. */
const fundQueue: Array<() => void> = [];
let fundActive = 0;
const FUND_CONCURRENCY = 3;

function withFundSlot<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = async () => {
      fundActive++;
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        fundActive--;
        const next = fundQueue.shift();
        if (next) next();
      }
    };
    if (fundActive < FUND_CONCURRENCY) run();
    else fundQueue.push(run);
  });
}

export async function fetchStockData(symbol: string): Promise<StockData> {
  const sym = symbol.trim().toUpperCase();

  const [chartSettled, newsSettled, fundSettled] = await Promise.allSettled([
    fetchChart(sym),
    fetchNewsCandidates(sym),
    withFundSlot(() => fetchFundamentals(sym)),
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
      : {
          forwardPE: null,
          recommendation: null,
          targetPrice: null,
        };

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
    marketState: null,
    fetchedAt: new Date().toISOString(),
  };
}

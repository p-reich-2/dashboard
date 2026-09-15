import { execFile } from "child_process";
import { promisify } from "util";
import type { PriceLabel, StockData } from "./types";

const execFileAsync = promisify(execFile);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

async function fetchNews(
  symbol: string
): Promise<{ title: string | null; url: string | null }> {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
    symbol
  )}&newsCount=5&quotesCount=0`;
  try {
    const json = (await yahooJson(url)) as {
      news?: Array<{
        title?: string;
        link?: string;
        relatedTickers?: string[];
      }>;
    };
    const news = json.news ?? [];
    const related =
      news.find((n) =>
        (n.relatedTickers ?? []).some((t) => t.toUpperCase() === symbol)
      ) ?? news[0];
    return {
      title: related?.title ?? null,
      url: related?.link ?? null,
    };
  } catch {
    return { title: null, url: null };
  }
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
    fetchNews(sym),
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

  const news =
    newsSettled.status === "fulfilled"
      ? newsSettled.value
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
    name: meta.shortName || meta.longName || null,
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

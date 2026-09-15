"use client";

import { Sparkline } from "./Sparkline";
import type { StockData } from "@/lib/types";

interface StockTileProps {
  symbol: string;
  data?: StockData | null;
  loading?: boolean;
  error?: string | null;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: n >= 1000 ? 2 : 2,
  });
}

function fmtPE(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(1);
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function StockTile({ symbol, data, loading, error }: StockTileProps) {
  if (loading && !data) {
    return (
      <article className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4 animate-pulse min-h-[220px]">
        <div className="flex justify-between items-start mb-3">
          <div className="h-6 w-16 bg-zinc-700 rounded" />
          <div className="h-5 w-14 bg-zinc-700 rounded" />
        </div>
        <div className="h-8 w-28 bg-zinc-700 rounded mb-2" />
        <div className="h-3 w-20 bg-zinc-800 rounded mb-4" />
        <div className="space-y-2">
          <div className="h-3 w-full bg-zinc-800 rounded" />
          <div className="h-3 w-3/4 bg-zinc-800 rounded" />
          <div className="h-3 w-2/3 bg-zinc-800 rounded" />
        </div>
        <div className="mt-4 h-9 w-28 bg-zinc-800 rounded" />
      </article>
    );
  }

  if (error && !data) {
    return (
      <article className="rounded-2xl border border-red-900/50 bg-zinc-900/80 p-4 min-h-[220px]">
        <div className="text-lg font-semibold text-zinc-100 tracking-wide">
          {symbol}
        </div>
        <p className="mt-3 text-sm text-red-400">Failed to load</p>
        <p className="mt-1 text-xs text-zinc-500 break-words">{error}</p>
      </article>
    );
  }

  if (!data) return null;

  const up = (data.changePercent ?? 0) >= 0;
  const changeColor = up ? "text-emerald-400" : "text-red-400";
  const hasNews = Boolean(data.newsTitle && data.newsUrl);

  return (
    <article className="rounded-2xl border border-zinc-800 bg-zinc-900/90 p-4 shadow-lg shadow-black/20 flex flex-col gap-3 min-h-[220px] hover:border-zinc-700 transition-colors">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold tracking-wide text-zinc-50">
            {data.symbol}
          </h2>
          {data.name && (
            <p className="text-[11px] text-zinc-500 truncate max-w-[160px]">
              {data.name}
            </p>
          )}
        </div>
        <span className={`text-sm font-semibold tabular-nums ${changeColor}`}>
          {fmtPct(data.changePercent)}
        </span>
      </header>

      <div>
        <div className="text-2xl font-semibold tabular-nums text-zinc-50">
          {fmtPrice(data.price)}
        </div>
        <div className="text-[11px] uppercase tracking-wider text-zinc-500 mt-0.5">
          {data.priceLabel}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <div>
          <dt className="text-zinc-500">Forward PE</dt>
          <dd className="text-zinc-200 tabular-nums font-medium">
            {fmtPE(data.forwardPE)}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">Analyst</dt>
          <dd className="text-zinc-200 font-medium capitalize">
            {data.recommendation ?? "—"}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-zinc-500">Price target</dt>
          <dd className="text-zinc-200 tabular-nums font-medium">
            {fmtPrice(data.targetPrice)}
          </dd>
        </div>
      </dl>

      <div className="mt-auto">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
          5-day trend
        </div>
        <Sparkline data={data.sparkline} positive={up} />
      </div>

      {hasNews && (
        <div className="border-t border-zinc-800 pt-2">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
            Latest news
          </div>
          <a
            href={data.newsUrl!}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-sky-400 hover:text-sky-300 line-clamp-2 leading-snug"
          >
            {data.newsTitle}
          </a>
        </div>
      )}
    </article>
  );
}

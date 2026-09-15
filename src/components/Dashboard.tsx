"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { StockTile } from "./StockTile";
import type { StockData } from "@/lib/types";

interface TileState {
  data: StockData | null;
  loading: boolean;
  error: string | null;
}

function formatPacific(iso: string | null): string {
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

export function Dashboard({ tickers }: { tickers: string[] }) {
  const [tiles, setTiles] = useState<Record<string, TileState>>(() =>
    Object.fromEntries(
      tickers.map((s) => [s, { data: null, loading: true, error: null }])
    )
  );
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadAll = useCallback(async () => {
    setTiles(
      Object.fromEntries(
        tickers.map((s) => [
          s,
          {
            data: null,
            loading: true,
            error: null,
          },
        ])
      )
    );
    setLastUpdated(null);

    await Promise.all(
      tickers.map(async (symbol) => {
        try {
          const res = await fetch(`/api/stocks/${encodeURIComponent(symbol)}`, {
            cache: "no-store",
          });
          const body = await res.json();
          if (!res.ok) {
            setTiles((prev) => ({
              ...prev,
              [symbol]: {
                data: null,
                loading: false,
                error: body.error ?? `HTTP ${res.status}`,
              },
            }));
            return;
          }
          setTiles((prev) => ({
            ...prev,
            [symbol]: { data: body as StockData, loading: false, error: null },
          }));
          setLastUpdated((prev) => {
            const t = (body as StockData).fetchedAt;
            if (!prev || t > prev) return t;
            return prev;
          });
        } catch (err) {
          setTiles((prev) => ({
            ...prev,
            [symbol]: {
              data: null,
              loading: false,
              error: err instanceof Error ? err.message : "Network error",
            },
          }));
        }
      })
    );
  }, [tickers]);

  useEffect(() => {
    loadAll();
  }, [loadAll, refreshKey]);

  const loadingCount = useMemo(
    () => Object.values(tiles).filter((t) => t.loading).length,
    [tiles]
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">
              Stock Watchlist
            </h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              Last updated (Pacific):{" "}
              <span className="text-zinc-300">
                {loadingCount > 0 && !lastUpdated
                  ? "Loading…"
                  : formatPacific(lastUpdated)}
              </span>
              {loadingCount > 0 && (
                <span className="ml-2 text-amber-400/90">
                  · {loadingCount} loading
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 hover:border-zinc-600 active:scale-[0.98] transition"
          >
            Refresh
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-4 sm:px-6 sm:py-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
          {tickers.map((symbol) => {
            const t = tiles[symbol];
            return (
              <StockTile
                key={symbol}
                symbol={symbol}
                data={t?.data}
                loading={t?.loading}
                error={t?.error}
              />
            );
          })}
        </div>
      </main>

      <footer className="mx-auto max-w-7xl px-4 pb-8 text-center text-[11px] text-zinc-600">
        Data via Yahoo Finance (unofficial). Not investment advice.
      </footer>
    </div>
  );
}

# Stock Watchlist Dashboard

Mobile-first dark-theme stock watchlist built with **Next.js 14**, **React**, **TypeScript**, and **Tailwind CSS**. Market data is fetched on the server from Yahoo Finance (unofficial free endpoints) so the browser avoids CORS issues. No API keys or login required.

## Features

- Responsive tile grid (1 column on phone → multi-column on desktop)
- Per-tile loading and error states; tiles load in parallel
- Price with Premarket / After-hours / Market / Last close label
- Forward PE, consensus analyst recommendation, mean price target
- Daily % change (green / red)
- Latest news title with link (opens in a new tab)
- 5-day sparkline
- Last-updated timestamp in **America/Los_Angeles** (Pacific)
- Refresh button; data also loads on every page open

## Requirements

- Node.js 20+
- npm
- `curl` (used server-side to fetch Yahoo quote HTML for fundamentals; chart/news use `fetch`)

## Setup & run

```bash
cd /workspace/stock-dashboard
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Production

```bash
npm run build
npm start
```

## Changing tickers

Edit `src/config/tickers.ts` and update the `TICKERS` array. Use Yahoo Finance symbols (e.g. `BRK-B`).

```ts
export const TICKERS: string[] = [
  "TSLA",
  "NVDA",
  // add or remove symbols here
];
```

Restart the dev server (or rebuild) after changing the list.

## How data is fetched

```
Browser  →  GET /api/stocks/[symbol]  →  Yahoo Finance
              ├─ chart API     → price, daily %, 5-day sparkline
              ├─ search API    → latest news
              └─ quote HTML    → forward PE, analyst rec, price target
```

Each tile requests its own symbol in parallel for fast first paint and independent error handling. Missing fields (common for ETFs / illiquid names) render as **—**.

## Notes

- Unofficial Yahoo Finance data; not investment advice.
- Yahoo may rate-limit; fundamentals scraping is concurrency-limited.
- Some tickers (e.g. certain ETFs) legitimately have no PE / analyst coverage.

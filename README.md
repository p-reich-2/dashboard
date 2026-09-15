# Stock Watchlist Dashboard

Mobile-first dark-theme stock watchlist built with **Next.js 14**, **React**, **TypeScript**, and **Tailwind CSS**. Market data is fetched on the server from Yahoo Finance (unofficial free endpoints) so the browser avoids CORS issues. No API keys or login required.

## Features

- Responsive tile grid (1 column on phone → multi-column on desktop)
- Per-tile loading and error states; tiles load in parallel
- Price with Premarket / After-hours / Market / Last close label
- Forward PE, consensus analyst recommendation, mean price target
- Daily % change (green / red)
- Company-specific news (title + link) when Yahoo has a relevant story from the last 48 hours; otherwise the news row is hidden
- 5-day sparkline
- Last-updated timestamp in **America/Los_Angeles** (Pacific)
- Refresh button; data also loads on every page open

## Requirements

- Node.js 20+
- npm
- `curl` (used server-side to fetch Yahoo quote HTML for fundamentals; chart/news use `fetch`)
- Google Chrome / Chromium (for PNG report screenshots via `puppeteer-core`)

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

## Morning report (HTML + PNG)

With the Next.js API running on `localhost:3000`:

```bash
node scripts/generate-report.mjs /workspace/stock-report-sample.html
```

This writes:

| Artifact | Path (default) | Use |
|---|---|---|
| **PNG (primary)** | `/workspace/stock-report-sample.png` | **Attach this in morning routines** — phone-readable full-page screenshot of the dark-theme tiles |
| HTML (secondary) | `/workspace/stock-report-sample.html` | Optional desktop / archive copy |
| Text summary | `/workspace/stock-report-sample-summary.txt` | Quick glance |

PNG is rendered with **puppeteer-core** against system Chrome (`/usr/bin/google-chrome-stable`, override with `CHROME_PATH`). Viewport is ~900px wide at 2× DPR with `fullPage: true` so sparklines and tiles stay readable on phone.

**Morning routine guidance:** attach the **PNG** as the primary report Paul opens on phone. Include the HTML only as an optional secondary attachment for desktop.

## How data is fetched

```
Browser  →  GET /api/stocks/[symbol]  →  Yahoo Finance
              ├─ chart API     → price, daily %, 5-day sparkline, company name
              ├─ search API    → news candidates (filtered: last 48h + title/summary names company or ticker)
              └─ quote HTML    → forward PE, analyst rec, price target
```

News filtering is strict: generic market/sector pieces that only list the ticker in `relatedTickers` are dropped. If nothing qualifies, `newsTitle` / `newsUrl` are `null` and the UI/report omit the news row.

Each tile requests its own symbol in parallel for fast first paint and independent error handling. Missing fields (common for ETFs / illiquid names) render as **—**.

## Notes

- Unofficial Yahoo Finance data; not investment advice.
- Yahoo may rate-limit; fundamentals scraping is concurrency-limited.
- Some tickers (e.g. certain ETFs) legitimately have no PE / analyst coverage.

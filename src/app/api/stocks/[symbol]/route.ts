import { NextResponse } from "next/server";
import { fetchStockData } from "@/lib/yahoo";
import { TICKERS } from "@/config/tickers";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: Request,
  { params }: { params: { symbol: string } }
) {
  const symbol = decodeURIComponent(params.symbol).toUpperCase();

  // Soft allow-list: prefer configured tickers, but still allow any for flexibility
  if (!TICKERS.includes(symbol) && !/^[A-Z0-9.^=-]{1,12}$/.test(symbol)) {
    return NextResponse.json(
      { symbol, error: "Invalid symbol" },
      { status: 400 }
    );
  }

  try {
    const data = await fetchStockData(symbol);
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fetch failed";
    return NextResponse.json(
      { symbol, error: message },
      { status: 502 }
    );
  }
}

import { NextResponse } from "next/server";
import { TICKERS } from "@/config/tickers";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ tickers: TICKERS });
}

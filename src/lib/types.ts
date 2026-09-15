export type PriceLabel = "Premarket" | "After-hours" | "Last close" | "Market";

export interface StockData {
  symbol: string;
  name: string | null;
  price: number | null;
  priceLabel: PriceLabel;
  changePercent: number | null;
  forwardPE: number | null;
  recommendation: string | null;
  targetPrice: number | null;
  newsTitle: string | null;
  newsUrl: string | null;
  sparkline: number[];
  marketState: string | null;
  fetchedAt: string;
}

export interface StockError {
  symbol: string;
  error: string;
}

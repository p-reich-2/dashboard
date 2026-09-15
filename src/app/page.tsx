import { Dashboard } from "@/components/Dashboard";
import { TICKERS } from "@/config/tickers";

export default function Home() {
  return <Dashboard tickers={TICKERS} />;
}

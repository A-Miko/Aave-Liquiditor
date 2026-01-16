import { runWatchlistMonitor } from "./watchlist_worker";

runWatchlistMonitor("highfreq").catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

import { runWatchlistMonitor } from "./watchlist_worker";

runWatchlistMonitor("normal").catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

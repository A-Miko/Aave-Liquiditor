#!/usr/bin/env bash
set -euo pipefail

echo "Starting discovery..."
node dist/src/index.js &
PID_DISCOVERY=$!

echo "Starting watchlist highfreq..."
node -e "import('./dist/scripts/watchlist_worker.js').then(m=>m.runWatchlistMonitor('highfreq')).catch(e=>{console.error(e);process.exit(1);})" &
PID_HF=$!

echo "Starting watchlist normal..."
node -e "import('./dist/scripts/watchlist_worker.js').then(m=>m.runWatchlistMonitor('normal')).catch(e=>{console.error(e);process.exit(1);})" &
PID_NORMAL=$!

wait -n

echo "One monitor exited; stopping container..."
kill $PID_DISCOVERY $PID_HF $PID_NORMAL 2>/dev/null || true
wait || true
exit 1

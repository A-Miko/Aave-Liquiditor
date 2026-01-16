import "dotenv/config";
import { Pool } from "pg";
import { ethers } from "ethers";
import { RpcProvider } from "../src/monitor/RpcProvider";

const AAVE_POOL_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getReservesList() view returns (address[])",
  "function getConfiguration(address asset) view returns (tuple(uint256 data) config)",
  "function getUserConfiguration(address user) view returns (tuple(uint256 data) config)",
];

const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) external view returns (tuple(bool success, bytes returnData)[] returnData)"
];

const AAVE_ORACLE_ABI = [
  "function getAssetPrice(address asset) external view returns (uint256)",
  "function BASE_CURRENCY_UNIT() external view returns (uint256)",
];

type Mode = "highfreq" | "normal";

type DueBorrowerRow = {
  borrower_id: number;
  user_address: string;
};

export async function runWatchlistMonitor(mode: Mode) {
  const chainId = parseInt(process.env.CHAIN_ID ?? "42161", 10);

  const intervalMs =
    mode === "highfreq"
      ? parseInt(process.env.HIGHFREQ_MONITOR_INTERVAL_MS ?? "30000", 10)
      : parseInt(process.env.NORMAL_MONITOR_INTERVAL_MS ?? "300000", 10);

  const batchSize = parseInt(process.env.WATCHLIST_BATCH_SIZE ?? "100", 10);
  const minHealthFactor = parseFloat(process.env.MIN_HEALTH_FACTOR ?? "1");

  const pool = new Pool({
    connectionString: `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  });

  const rpcProvider = new RpcProvider();
  const provider = rpcProvider.getProvider();

  const aavePool = new ethers.Contract(process.env.AAVE_LENDING_POOL || "", AAVE_POOL_ABI, provider);

  const multicallAddr = process.env.MULTICALL3_ADDR || "0xca11bde05977b3631167028862be2a173976ca11";
  const multicall = new ethers.Contract(multicallAddr, MULTICALL3_ABI, provider);

  // Oracle (use env var directly; add discovery if you need it)
  const oracleAddr = process.env.AAVE_ORACLE || "";
  const oracle = new ethers.Contract(oracleAddr, AAVE_ORACLE_ABI, provider);

  let reservesList: string[] | null = null;

  async function getReservesList(): Promise<string[]> {
    if (reservesList === null) {
      reservesList = (await aavePool.getReservesList()) as string[];
    }
    return reservesList;
  }

  async function getUserCollateral(user: string): Promise<string | null> {
    const reserves = await getReservesList();
    const { data } = await aavePool.getUserConfiguration(user);
    const config = BigInt(data.toString());

    for (let i = 0; i < reserves.length; i++) {
      const isUsedAsCollateral = Boolean((config >> BigInt(i * 2)) & 1n);
      if (isUsedAsCollateral) return reserves[i];
    }
    return null;
  }

  async function getReserveConfig(asset: string): Promise<{ liquidationBonus: number }> {
    const { data } = await aavePool.getConfiguration(asset);
    const config = BigInt(data.toString());
    const liquidationBonus = Number((config >> 32n) & 0xFFFFn) / 100; // same packing as your discovery script
    return { liquidationBonus };
  }

  async function getAssetPriceUSD(asset: string): Promise<number> {
    const [price, unit]: [bigint, bigint] = await Promise.all([
      oracle.getAssetPrice(asset),
      oracle.BASE_CURRENCY_UNIT(),
    ]);
    return Number(price) / Number(unit);
  }

  async function fetchDueBorrowers(): Promise<DueBorrowerRow[]> {
    const lastStatus = mode === "highfreq" ? "highfreq-watchlist" : "normal-watchlist";

    const res = await pool.query<DueBorrowerRow>(
      `
      SELECT bms.borrower_id, b.user_address
      FROM borrower_monitor_state bms
      JOIN borrowers b ON b.id = bms.borrower_id
      WHERE b.chain_id = $1
        AND bms.last_status = $2
        AND bms.next_check_at <= now()
      ORDER BY bms.next_check_at ASC
      LIMIT $3
      `,
      [chainId, lastStatus, batchSize]
    );

    return res.rows;
  }

  async function updateMonitorState(args: {
    borrowerId: number;
    hf?: number;
    status?: string;
    error?: string | null;
    nextCheckSeconds: number;
  }) {
    await pool.query(
      `
      UPDATE borrower_monitor_state
      SET last_check_at = now(),
          last_health_factor = COALESCE($2, last_health_factor),
          last_status = COALESCE($3, last_status),
          last_error = $4,
          next_check_at = now() + ($5::text || ' seconds')::interval
      WHERE borrower_id = $1
      `,
      [args.borrowerId, args.hf ?? null, args.status ?? null, args.error ?? null, args.nextCheckSeconds]
    );
  }

  async function saveOpportunity(args: {
    borrowerId: number;
    hf: number;
    collateralAsset?: string | null;
    totalCollateralBase?: number;
    totalDebtBase?: number;
    estimatedProfitUsd?: number;
    notes?: string;
  }) {
    await pool.query(
      `
      INSERT INTO liquidation_opportunities
        (borrower_id, health_factor, collateral_asset_address, total_collateral_base, total_debt_base, estimated_profit_usd, notes)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        args.borrowerId,
        args.hf,
        args.collateralAsset ?? null,
        args.totalCollateralBase ?? null,
        args.totalDebtBase ?? null,
        args.estimatedProfitUsd ?? null,
        args.notes ?? null,
      ]
    );
  }

  async function getUserAccountDataBatch(users: string[]) {
    const iface = aavePool.interface;
    const calls = users.map((u) => ({
      target: aavePool.target as string,
      allowFailure: true,
      callData: iface.encodeFunctionData("getUserAccountData", [u]),
    }));

    const results: Array<{ success: boolean; returnData: string }> = await multicall.aggregate3(calls);

    return results.map((r) => {
      if (!r.success) return null;
      const decoded = iface.decodeFunctionResult("getUserAccountData", r.returnData);
      return {
        totalCollateralBase: decoded[0] as bigint,
        totalDebtBase: decoded[1] as bigint,
        healthFactor: decoded[5] as bigint,
      };
    });
  }

  async function tick() {
    const due = await fetchDueBorrowers();
    if (due.length === 0) return;

    const users = due.map((r) => r.user_address.toLowerCase());
    const data = await getUserAccountDataBatch(users);

    for (let i = 0; i < due.length; i++) {
      const row = due[i];
      const account = data[i];

      if (!account) {
        await updateMonitorState({
          borrowerId: row.borrower_id,
          error: "multicall-failed",
          nextCheckSeconds: mode === "highfreq" ? 30 : 300,
        });
        continue;
      }

      const hf = parseFloat(ethers.formatUnits(account.healthFactor, 18));

      // Always update HF + schedule next check
      await updateMonitorState({
        borrowerId: row.borrower_id,
        hf,
        error: null,
        nextCheckSeconds: mode === "highfreq" ? 30 : 300,
      });

      // Only do profit calc when unhealthy
      if (hf >= minHealthFactor) continue;

      // Profit estimation (mirrors your discovery logic)
      const totalCollateralBase = parseFloat(ethers.formatUnits(account.totalCollateralBase, 18));
      const totalDebtBase = parseFloat(ethers.formatUnits(account.totalDebtBase, 18));

      const collateralAsset = await getUserCollateral(users[i]);
      if (!collateralAsset) {
        await saveOpportunity({
          borrowerId: row.borrower_id,
          hf,
          notes: "No collateral asset found via user configuration",
        });
        continue;
      }

      const { liquidationBonus } = await getReserveConfig(collateralAsset);

      const maxLiquidation = totalDebtBase * 0.5;
      const estimatedProfitBase = maxLiquidation * (liquidationBonus / 100) - maxLiquidation * 0.001;

      const collateralPriceUsd = await getAssetPriceUSD(collateralAsset);
      const estimatedProfitUsd = estimatedProfitBase * collateralPriceUsd;

      await saveOpportunity({
        borrowerId: row.borrower_id,
        hf,
        collateralAsset,
        totalCollateralBase,
        totalDebtBase,
        estimatedProfitUsd,
      });
    }
  }

  // simple scheduler
  console.log(`[watchlist-${mode}] started (interval=${intervalMs}ms)`);
  await tick();
  setInterval(() => tick().catch((e) => console.error(`[watchlist-${mode}] tick error`, e)), intervalMs);
}

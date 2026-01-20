import "dotenv/config";
import { Pool } from "pg";
import { ethers } from "ethers";
import { RpcProvider } from "../src/monitor/RpcProvider";
import { evaluateProfit } from "../src/liquidation/profit";

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
  "function getAssetsPrices(address[] assets) external view returns (uint256[] memory)",
  "function BASE_CURRENCY_UNIT() external view returns (uint256)",
];

const AAVE_DATA_PROVIDER_ABI = [
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

const minHfWad = ethers.parseUnits(process.env.MIN_HEALTH_FACTOR ?? "1", 18);

type Mode = "highfreq" | "normal";

type DueBorrowerRow = {
  borrower_id: number;
  user_address: string;
};

const HF_DB_MAX_WAD = 10n ** 38n - 1n; // max representable in numeric(38,18) after scaling by 1e18

function hfToDb(hfWad: bigint): string | null {
  if (hfWad < 0n) return null;
  if (hfWad > HF_DB_MAX_WAD) return null; // treat as infinite/unrepresentable
  return ethers.formatUnits(hfWad, 18);   // "1.0345"
}

export async function runWatchlistMonitor(mode: Mode) {
  const chainId = parseInt(process.env.CHAIN_ID ?? "42161", 10);

  const intervalMs =
    mode === "highfreq"
      ? parseInt(process.env.HIGHFREQ_MONITOR_INTERVAL_MS ?? "30000", 10)
      : parseInt(process.env.NORMAL_MONITOR_INTERVAL_MS ?? "300000", 10);

  const batchSize = parseInt(process.env.WATCHLIST_BATCH_SIZE ?? "100", 10);

  const pool = new Pool({
    connectionString: `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  });

  const rpcProvider = new RpcProvider();
  const provider = rpcProvider.getProvider();

  const dp = process.env.AAVE_PROTOCOL_DATA_PROVIDER || "";
  if (!dp) throw new Error("Missing AAVE_PROTOCOL_DATA_PROVIDER");
  const dataProvider = new ethers.Contract(dp, AAVE_DATA_PROVIDER_ABI, provider);

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

  async function getATokenAddress(asset: string): Promise<string> {
    const [aTokenAddress] = await dataProvider.getReserveTokensAddresses(asset);
    return aTokenAddress;
  }

  async function getUserCollaterals(user: string): Promise<string[]> {
    const reserves = await getReservesList();
    const { data } = await aavePool.getUserConfiguration(user);
    const cfg = BigInt(data.toString());

    const collaterals: string[] = [];
    for (let i = 0; i < reserves.length; i++) {
      const isCollateral = (cfg >> BigInt(i * 2)) & 1n;
      if (isCollateral !== 1n) continue;

      const aTokenAddr = await getATokenAddress(reserves[i]);
      const aToken = new ethers.Contract(aTokenAddr, ERC20_ABI, provider);
      const bal: bigint = await aToken.balanceOf(user);

      if (bal > 0n) collaterals.push(reserves[i]);
    }
    return collaterals;
  }

  async function getUserDebts(user: string): Promise<Array<{ asset: string; stableDebt: bigint; variableDebt: bigint }>> {
    const reserves = await getReservesList();
    const debts: Array<{ asset: string; stableDebt: bigint; variableDebt: bigint }> = [];

    for (const asset of reserves) {
      const rd = await dataProvider.getUserReserveData(asset, user);
      if (rd.currentStableDebt > 0n || rd.currentVariableDebt > 0n) {
        debts.push({ asset, stableDebt: rd.currentStableDebt, variableDebt: rd.currentVariableDebt });
      }
    }
    return debts;
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
    hf?: string | null;
    status?: string;
    error?: string | null;
    nextCheckSeconds: number;
  }) {
    await pool.query(
      `
      UPDATE borrower_monitor_state
      SET last_check_at = now(),
          last_health_factor = $2,
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
    hf: string | null;
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

      const hfWad: bigint = account.healthFactor;
      const hfDb = hfToDb(hfWad);

      if (hfDb === null) {
        // infinite/no-debt HF; skip storing opportunities (and probably skip profit calc)
        continue;
      }

      // Always update HF + schedule next check
      await updateMonitorState({
        borrowerId: row.borrower_id,
        hf: hfDb,
        error: null,
        nextCheckSeconds: mode === "highfreq" ? 30 : 300,
      });

      // Only do profit calc when unhealthy
      if (hfWad >= minHfWad) continue;

      // Profit estimation (mirrors your discovery logic)
      const totalCollateralBase = parseFloat(ethers.formatUnits(account.totalCollateralBase, 18));
      const totalDebtBase = parseFloat(ethers.formatUnits(account.totalDebtBase, 18));

      // 1) Fetch per-asset state
      const user = users[i];
      const collaterals = await getUserCollaterals(user); // assets with actual aToken balance
      const debts = await getUserDebts(user); // per-asset stable/variable

      if (collaterals.length === 0 || debts.length === 0) {
        await saveOpportunity({
          borrowerId: row.borrower_id,
          hf: hfDb,
          totalCollateralBase,
          totalDebtBase,
          notes: "hf<min but no collateral or no debt found",
        });
        continue;
      }

      // 2) Get oracle prices + base unit for ALL involved assets
      const assets = [...new Set([...collaterals, ...debts.map(d => d.asset)].map(a => a.toLowerCase()))];
      const [prices, baseUnit] = await Promise.all([
        oracle.getAssetsPrices(assets) as Promise<bigint[]>,
        oracle.BASE_CURRENCY_UNIT() as Promise<bigint>,
      ]);

      const priceByAsset = new Map<string, bigint>();
      assets.forEach((a, idx) => priceByAsset.set(a.toLowerCase(), prices[idx]));

      // 3) Evaluate every (debt, collateral) combo and pick best
      const closeFactorBps = 5000n; // placeholder
      const dexFeeBps = 30n;

      let best:
      | { debtAsset: string; collateralAsset: string; repayAmount: bigint; profitUsd: number; profitBase: bigint }
      | null = null;

      for (const d of debts) {
        const debtAmount = d.variableDebt; // optional: also consider d.stableDebt
        if (debtAmount === 0n) continue;

        // decimals for debt asset
        const debtCfg = await dataProvider.getReserveConfigurationData(d.asset);
        const debtDecimals = Number(debtCfg.decimals);

        const priceDebt = priceByAsset.get(d.asset.toLowerCase());
        if (!priceDebt) continue;

        for (const c of collaterals) {
          // collateral balance (aToken balance)
          const aTokenAddr = await getATokenAddress(c);
          const aToken = new ethers.Contract(aTokenAddr, ERC20_ABI, provider);
          const collateralBalance: bigint = await aToken.balanceOf(user);
          if (collateralBalance === 0n) continue;

          const colCfg = await dataProvider.getReserveConfigurationData(c);
          const colDecimals = Number(colCfg.decimals);
          const liquidationBonusBps = BigInt(colCfg.liquidationBonus);

          const priceCol = priceByAsset.get(c.toLowerCase());
          if (!priceCol) continue;

          const { repayAmount, profitBase, profitUsdApprox } = evaluateProfit({
            debtAmount,
            collateralBalance,
            priceDebt,
            priceCol,
            baseUnit,
            closeFactorBps,
            liquidationBonusBps,
            dexFeeBps,
            debtDecimals,
            colDecimals,
          });

          if (repayAmount === 0n) continue;

          if (!best || profitUsdApprox > best.profitUsd) {
            best = {
              debtAsset: d.asset,
              collateralAsset: c,
              repayAmount,
              profitUsd: profitUsdApprox,
              profitBase,
            };
          }
        }
      }

      if (!best) {
        await saveOpportunity({
          borrowerId: row.borrower_id,
          hf: hfDb,
          totalCollateralBase,
          totalDebtBase,
          notes: "hf<min but no repayable profitable pair found",
        });
        continue;
      }

      // 4) Persist (keep schema, store extra info in notes for now)
      await saveOpportunity({
        borrowerId: row.borrower_id,
        hf: hfDb,
        collateralAsset: best.collateralAsset,
        totalCollateralBase,
        totalDebtBase,
        estimatedProfitUsd: best.profitUsd,
        notes: `debtAsset=${best.debtAsset} repayAmount=${best.repayAmount.toString()} profitBase=${best.profitBase.toString()}`,
      });
    }
  }

  // simple scheduler
  console.log(`[watchlist-${mode}] started (interval=${intervalMs}ms)`);
  await tick();
  setInterval(() => tick().catch((e) => console.error(`[watchlist-${mode}] tick error`, e)), intervalMs);
}

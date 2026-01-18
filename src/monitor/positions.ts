import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import axios from 'axios';
import { Pool } from 'pg';
import { RpcProvider } from "./RpcProvider";
import { evaluateProfit } from "../liquidation/profit";

dotenv.config();

// Minimum ABI needed to query Aave Pool
const AAVE_POOL_ABI = [
    "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
    "function getReservesList() view returns (address[])",
    "function getReserveData(address asset) view returns (tuple(uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id) )",
    "function getConfiguration(address asset) view returns (tuple(uint256 data) config)",
    "function getUserConfiguration(address user) view returns (tuple(uint256 data) config)",
    "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
    "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external",
    "function getAssetsPrices(address[] assets) external view returns (uint256[])",
];

const AAVE_DATA_PROVIDER_ABI = [
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)"
];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

// Interface for reserve configuration
interface ReserveConfig {
    ltv: number;
    liquidationThreshold: number;
    liquidationBonus: number;
    decimals: number;
    reserveFactor: number;
    usageAsCollateralEnabled: boolean;
    borrowingEnabled: boolean;
    stableBorrowRateEnabled: boolean;
    isActive: boolean;
    isFrozen: boolean;
}

interface Position {
    user: string;
    healthFactor: bigint;
    totalCollateralETH: number;
    totalDebtETH: number;
    estimatedProfit: number;
    collateralAsset?: string;
    liquidationBonus?: number;
}

interface Opportunity {
    debtAsset: string;
    collateralAsset: string;
    repayAmount: bigint;
    estimatedProfitUsd?: number;
}

type SubgraphPosition = {
  id: string;
  account: { id: string };
  principal: string;
}

type UserAccountData = {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  currentLiquidationThreshold: bigint;
  ltv: bigint;
  healthFactor: bigint;
};

const MULTICALL3_ADDR = process.env.MULTICALL3_ADDR || "0xca11bde05977b3631167028862be2a173976ca11";
const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) external view returns (tuple(bool success, bytes returnData)[] returnData)"
];

const ADDRESSES_PROVIDER_ABI = [
  "function getPriceOracle() external view returns (address)",
  "function getPoolDataProvider() external view returns (address)",
  "function getPool() external view returns (address)",
];

const AAVE_ORACLE_ABI = [
  "function getAssetPrice(address asset) external view returns (uint256)",
  "function getAssetsPrices(address[] assets) external view returns (uint256[] memory)",
  "function BASE_CURRENCY_UNIT() external view returns (uint256)"
];

const DATABASE_URL = `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;

export class PositionMonitor {
    private provider: ethers.AbstractProvider;
    private pool: ethers.Contract;
    private minHealthFactor: bigint;
    private minHealthFactorThreshold: bigint;
    private minProfitUSD: number;
    private reservesList: string[] | null;
    private oracle: ethers.Contract | null = null;
    private highFrequencyHealthFactorCheck: bigint;
    private multicall: ethers.Contract;
    private db: Pool;
    private dataProvider: ethers.Contract;
    private ap: ethers.Contract;

    constructor() {
        const rpcProvider = new RpcProvider();
        this.provider = rpcProvider.getProvider();
        this.pool = new ethers.Contract(
            process.env.AAVE_LENDING_POOL || '',
            AAVE_POOL_ABI,
            this.provider
        );
        this.minHealthFactor = 1_000_000_000_000_000_000n;
        this.highFrequencyHealthFactorCheck = 1_010_000_000_000_000_000n;
        this.minHealthFactorThreshold = 1_050_000_000_000_000_000n;
        this.minProfitUSD = parseFloat(process.env.MIN_PROFIT_USD || '100');
        this.reservesList = null;
        this.multicall = new ethers.Contract(MULTICALL3_ADDR, MULTICALL3_ABI, this.provider);
        this.db = new Pool({ connectionString: DATABASE_URL });

        const dp = process.env.AAVE_PROTOCOL_DATA_PROVIDER;
        if (!dp) throw new Error("Missing AAVE_PROTOCOL_DATA_PROVIDER");

        this.dataProvider = new ethers.Contract(dp, AAVE_DATA_PROVIDER_ABI, this.provider);

        this.ap = new ethers.Contract(
          "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
          ADDRESSES_PROVIDER_ABI,
          this.provider
        );
        this.log();
    }

    private async log() {
        console.log("Pool =", await this.ap.getPool());
        console.log("PoolDataProvider =", await this.ap.getPoolDataProvider());
    }

    private async saveNormalWatchlistPlaceholder(args: { user: string; healthFactor: bigint }) {
        console.log(`📝 [normal-watchlist] user=${args.user} hf=${args.healthFactor}`);

        const chainId = parseInt(process.env.CHAIN_ID ?? "42161", 10);
        const user = args.user.toLowerCase();

        const normalPriority = parseInt(process.env.NORMAL_WATCHLIST_PRIORITY ?? "5", 10);
        const nextCheckSeconds = parseInt(process.env.NORMAL_NEXT_CHECK_SECONDS ?? "300", 10); // 5 min

        // 1) Upsert borrower and get borrower_id
        const borrowerRes = await this.db.query<{ id: string }>(
            `
            INSERT INTO borrowers (chain_id, user_address, first_seen_at, last_seen_at, active)
            VALUES ($1, $2, now(), now(), true)
            ON CONFLICT (chain_id, user_address)
            DO UPDATE SET last_seen_at = now(), active = true
            RETURNING id
            `,
            [chainId, user]
        );

        const borrowerId = borrowerRes.rows[0].id;

        // 2) Upsert monitor state
        await this.db.query(
            `
            INSERT INTO borrower_monitor_state
            (borrower_id, priority, next_check_at, last_check_at, last_health_factor, last_status, last_error)
            VALUES
            ($1, $2, now() + ($3::text || ' seconds')::interval, now(), $4, $5, NULL)
            ON CONFLICT (borrower_id)
            DO UPDATE SET
            priority = EXCLUDED.priority,
            next_check_at = EXCLUDED.next_check_at,
            last_check_at = EXCLUDED.last_check_at,
            last_health_factor = EXCLUDED.last_health_factor,
            last_status = EXCLUDED.last_status,
            last_error = NULL
            `,
            [borrowerId, normalPriority, nextCheckSeconds, args.healthFactor, "normal-watchlist"]
        );
    }

    private async saveHighFreqWatchlistPlaceholder(args: { user: string; healthFactor: bigint }) {
        const chainId = parseInt(process.env.CHAIN_ID ?? "42161", 10);
        const user = args.user.toLowerCase();

        const highPriority = parseInt(process.env.HIGHFREQ_WATCHLIST_PRIORITY ?? "10", 10);
        const nextCheckSeconds = parseInt(process.env.HIGHFREQ_NEXT_CHECK_SECONDS ?? "30", 10); // 30 sec

        const borrowerRes = await this.db.query<{ id: string }>(
            `
            INSERT INTO borrowers (chain_id, user_address, first_seen_at, last_seen_at, active)
            VALUES ($1, $2, now(), now(), true)
            ON CONFLICT (chain_id, user_address)
            DO UPDATE SET last_seen_at = now(), active = true
            RETURNING id
            `,
            [chainId, user]
        );

        const borrowerId = borrowerRes.rows[0].id;

        await this.db.query(
            `
            INSERT INTO borrower_monitor_state
            (borrower_id, priority, next_check_at, last_check_at, last_health_factor, last_status, last_error)
            VALUES
            ($1, $2, now() + ($3::text || ' seconds')::interval, now(), $4, $5, NULL)
            ON CONFLICT (borrower_id)
            DO UPDATE SET
            priority = EXCLUDED.priority,
            next_check_at = EXCLUDED.next_check_at,
            last_check_at = EXCLUDED.last_check_at,
            last_health_factor = EXCLUDED.last_health_factor,
            last_status = EXCLUDED.last_status,
            last_error = NULL
            `,
            [borrowerId, highPriority, nextCheckSeconds, args.healthFactor, "highfreq-watchlist"]
        );

        console.log(`⚡ [highfreq-watchlist] user=${user} hf=${args.healthFactor}`);
    }

    private async getATokenAddress(asset: string): Promise<string> {
        const [aTokenAddress] = await this.dataProvider.getReserveTokensAddresses(asset);
        return aTokenAddress;
    }

    private async getAaveOracle(): Promise<ethers.Contract> {
        if (this.oracle) return this.oracle;

        // Option A: Use env var directly (fastest)
        if (process.env.AAVE_ORACLE) {
            this.oracle = new ethers.Contract(process.env.AAVE_ORACLE, AAVE_ORACLE_ABI, this.provider);
            return this.oracle;
        }

        // Option B: Discover oracle from PoolAddressesProvider
        const providerAddr = process.env.AAVE_ADDRESSES_PROVIDER;
        if (!providerAddr) throw new Error("Missing AAVE_ADDRESSES_PROVIDER (or set AAVE_ORACLE).");

        const addressesProvider = new ethers.Contract(providerAddr, ADDRESSES_PROVIDER_ABI, this.provider);
        const oracleAddr: string = await addressesProvider.getPriceOracle(); // returns PriceOracle address [web:268]
        this.oracle = new ethers.Contract(oracleAddr, AAVE_ORACLE_ABI, this.provider);

        return this.oracle;
    }

    private async getAssetPriceUSD(asset: string): Promise<number> {
        const oracle = await this.getAaveOracle();

        // Oracle returns price in BASE_CURRENCY in wei; BASE_CURRENCY_UNIT tells the scaling. [web:470][web:265]
        const [price, unit]: [bigint, bigint] = await Promise.all([
            oracle.getAssetPrice(asset),
            oracle.BASE_CURRENCY_UNIT()
        ]);

        // Convert to a floating USD-ish number (base currency is usually USD in Aave v3 markets).
        // Keep it simple here; for production, avoid float and keep BigInt/decimal math.
        return Number(price) / Number(unit);
    }

    private async getBorrowersFromSubgraph(): Promise<string[]> {
        const borrowers = new Set<string>();
        let lastId = "";

        while (true) {
            const res = await axios.post(
                process.env.SUBGRAPH_URL!, 
                {
                    query: `
                        query ($lastId: String!) {
                            positions(
                                first: 1000, 
                                orderBy: id, 
                                orderDirection: asc,
                                where: { 
                                    id_gt: $lastId, 
                                    side: BORROWER, 
                                    principal_gt: "10000000" 
                                }
                            ) {
                                id
                                account { id }
                                principal
                            }
                        }
                    `,
                    variables: { lastId }
                },
                {
                    headers: {
                        Authorization: `Bearer ${process.env.SUBGRAPH_API_KEY}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            const positions = res.data?.data?.positions ?? [];
            if (positions.length === 0) break;

            for (const p of positions) borrowers.add(p.account.id.toLowerCase());
            lastId = positions[positions.length - 1].id;
        }
        console.log(`Found ${borrowers.size} borrowers`);

        return [...borrowers];
    }

    private async getReservesList(): Promise<string[]> {
        if (!this.reservesList) {
            this.reservesList = await this.pool.getReservesList();
        }
        return this.reservesList || [];
    }

    private async getUserCollateral(user: string): Promise<string | null> {
        const reserves = await this.getReservesList();
        const { data } = await this.pool.getUserConfiguration(user);
        const config = BigInt(data.toString());
        
        // Iterate over reserves to find active collateral
        for (let i = 0; i < reserves.length; i++) {
            const isUsedAsCollateral = Boolean((config >> BigInt(i * 2)) & 1n);
            if (isUsedAsCollateral) {
                return reserves[i];
            }
        }
        
        return null;
    }

    private async getUserCollaterals(user: string): Promise<string[]> {
        const config = await this.pool.getUserConfiguration(user);
        const reserves = await this.pool.getReservesList();

        const collaterals: string[] = [];

        for (let i = 0; i < reserves.length; i++) {
            const isCollateral = (config.data >> BigInt(i * 2)) & 1n;
            if (isCollateral === 1n) {
                const aTokenAddress = await this.getATokenAddress(reserves[i]);
                const aToken = new ethers.Contract(aTokenAddress, ERC20_ABI, this.provider);
                const bal: bigint = await aToken.balanceOf(user);

                if (bal > 0n) {
                    collaterals.push(reserves[i]);
                }
            }
        }

        return collaterals;
    }

    private async getUserDebts(user: string): Promise<{
        asset: string;
        stableDebt: bigint;
        variableDebt: bigint;
    }[]> {
        const reserves = await this.pool.getReservesList();
        const debts = [];

        for (const asset of reserves) {
            const reserveData = await this.dataProvider.getUserReserveData(asset, user);

            if (reserveData.currentStableDebt > 0n || reserveData.currentVariableDebt > 0n) {
            debts.push({
                asset,
                stableDebt: reserveData.currentStableDebt,
                variableDebt: reserveData.currentVariableDebt
            });
            }
        }

        return debts;
    }

    private async getLiquidationParams(asset: string) {
        const cfg = await this.dataProvider.getReserveConfigurationData(asset);

        // cfg.liquidationBonus is typically like 10500 (i.e. 5% bonus) depending on market/config
        const liquidationBonusBps = BigInt(cfg.liquidationBonus);
        const liquidationThresholdBps = BigInt(cfg.liquidationThreshold);

        // close factor: see note below
        const closeFactorBps = 5000n; // conservative default (50%)

        return { liquidationBonus: liquidationBonusBps, liquidationThreshold: liquidationThresholdBps, closeFactor: closeFactorBps };
    }

    private async getAssetDecimalsMap(assetAddresses: string[]): Promise<Map<string, number>> {
        const chainId = parseInt(process.env.CHAIN_ID ?? "42161", 10);
        const unique = Array.from(new Set(assetAddresses.map(a => a.toLowerCase())));

        const res = await this.db.query<{ asset_address: string; decimals: number }>(
            `
            SELECT asset_address, decimals
            FROM assets
            WHERE chain_id = $1
            AND asset_address = ANY($2::citext[])
            `,
            [chainId, unique]
        );

        const m = new Map<string, number>();
        for (const row of res.rows) {
            if (row.decimals == null) continue;
            m.set(row.asset_address.toLowerCase(), Number(row.decimals));
        }
        return m;
    }


    private async evaluateLiquidation(user: string): Promise<Opportunity[]> {
        const oracle = await this.getAaveOracle();

        const collaterals = await this.getUserCollaterals(user);
        const debts = await this.getUserDebts(user);

        const assets = [...collaterals, ...debts.map(d => d.asset)];
        const decimalsByAsset = await this.getAssetDecimalsMap(assets);
        const pricesArray = await oracle.getAssetsPrices(assets) as bigint[];

        const priceByAsset = new Map<string, bigint>();
        assets.forEach((a, i) => priceByAsset.set(a.toLowerCase(), pricesArray[i]));

        const baseUnit = await oracle.BASE_CURRENCY_UNIT() as bigint; // for profit calc if/when needed

        const opportunities: Opportunity[] = [];

        for (const debt of debts) {
            const debtAmount = debt.variableDebt;
            if (debtAmount === 0n) continue;

            for (const col of collaterals) {
                const colAddress = await this.getATokenAddress(col);
                const colToken = new ethers.Contract(colAddress, ERC20_ABI, this.provider);
                const colBalance = await colToken.balanceOf(user);
                if (colBalance === 0n) continue;

                const { liquidationBonus, closeFactor } = await this.getLiquidationParams(col);

                const priceDebt = priceByAsset.get(debt.asset.toLowerCase());
                const priceCol  = priceByAsset.get(col.toLowerCase());
                if (!priceDebt || !priceCol) continue;

                const debtDecimals = decimalsByAsset.get(debt.asset.toLowerCase());
                const colDecimals  = decimalsByAsset.get(col.toLowerCase());
                if (debtDecimals == null || colDecimals == null) continue;

                const { repayAmount, profitUsdApprox } = evaluateProfit({
                    debtAmount,
                    collateralBalance: colBalance,
                    priceDebt,
                    priceCol,
                    baseUnit,
                    closeFactorBps: closeFactor,
                    liquidationBonusBps: liquidationBonus,
                    dexFeeBps: 30n,
                    debtDecimals,
                    colDecimals,
                });

                if (profitUsdApprox < this.minProfitUSD) continue;

                if (repayAmount > 0n) {
                    opportunities.push({
                        debtAsset: debt.asset,
                        collateralAsset: col,
                        repayAmount,
                        estimatedProfitUsd: profitUsdApprox
                    });
                }
            }
        }

        return opportunities;
    }

    private async getReserveConfig(asset: string): Promise<ReserveConfig> {
        const { data } = await this.pool.getConfiguration(asset);
        const config = BigInt(data.toString());
        
        return {
            ltv: Number((config >> 0n) & 0xFFFFn) / 100,
            liquidationThreshold: Number((config >> 16n) & 0xFFFFn) / 100,
            liquidationBonus: Number((config >> 32n) & 0xFFFFn) / 100,
            decimals: Number((config >> 48n) & 0xFFn),
            reserveFactor: Number((config >> 64n) & 0xFFFFn) / 100,
            usageAsCollateralEnabled: Boolean((config >> 80n) & 1n),
            borrowingEnabled: Boolean((config >> 81n) & 1n),
            stableBorrowRateEnabled: Boolean((config >> 82n) & 1n),
            isActive: Boolean((config >> 83n) & 1n),
            isFrozen: Boolean((config >> 84n) & 1n)
        };
    }

    private async getUserAccountDataBatch(users: string[]): Promise<(UserAccountData | null)[]> {
        const iface = this.pool.interface;

        const calls = users.map((u) => ({
            target: this.pool.target as string,
            allowFailure: true,
            callData: iface.encodeFunctionData("getUserAccountData", [u]),
        }));

        const results: Array<{ success: boolean; returnData: string }> =
            await this.multicall.aggregate3(calls);

        return results.map((r) => {
            if (!r.success) return null;

            const decoded = iface.decodeFunctionResult("getUserAccountData", r.returnData);
            return {
                totalCollateralBase: decoded[0] as bigint,
                totalDebtBase: decoded[1] as bigint,
                availableBorrowsBase: decoded[2] as bigint,
                currentLiquidationThreshold: decoded[3] as bigint,
                ltv: decoded[4] as bigint,
                healthFactor: decoded[5] as bigint,
            };
        });
    }

    async findLiquidatablePositions(): Promise<Position[]> {
        try {
            const addresses = await this.getBorrowersFromSubgraph();
            const positions: Position[] = [];

            console.log(`🔍 Analyzing ${addresses.length} addresses...`);
            let checked = 0;
            const batchSize = parseInt(process.env.MULTICALL3_BATCH_SIZE || '100');

            for (let i = 0; i < addresses.length; i += batchSize) {
                const batchUsers = addresses.slice(i, i + batchSize);
                const batchData = await this.getUserAccountDataBatch(batchUsers);

                for (let j = 0; j < batchUsers.length; j++) {
                    const user = batchUsers[j];
                    const accountData = batchData[j];
                    if (!accountData) continue;

                    const hf = accountData.healthFactor;

                    // 1) Above threshold: > 1.05
                    if (hf >= this.minHealthFactorThreshold) { 
                        // ignore
                        continue;
                    } 
                    // 2) Between 1.05 and 1.01
                    else if (hf <= this.minHealthFactorThreshold && hf >= this.highFrequencyHealthFactorCheck) {
                        // normal watchlist: [HIGH_FREQUENCY, MIN_HEALTH_FACTOR_THRESHOLD) 
                        await this.saveNormalWatchlistPlaceholder({ user, healthFactor: hf });
                        continue;
                    } 
                    // 3) Between 1.01 and 1.00
                    else if (hf <= this.highFrequencyHealthFactorCheck && hf >= this.minHealthFactor) {
                        // 1.005 - high-frequency: [MIN_HEALTH_FACTOR, HIGH_FREQUENCY)
                        await this.saveHighFreqWatchlistPlaceholder({ user, healthFactor: hf });
                        continue;
                    }

                    // 4) Liquidatable candidates: hf < MIN_HEALTH_FACTOR -> do profitability checks
                    const opportunities: Opportunity[] = await this.evaluateLiquidation(user);

                    if (opportunities.length === 0) {
                        // Correct behavior: liquidatable but nothing seizable
                        continue;
                    }

                    for (const opp of opportunities) {
                        positions.push({
                            user,
                            healthFactor: accountData.healthFactor,
                            totalCollateralETH: Number(accountData.totalCollateralBase),
                            totalDebtETH: Number(accountData.totalDebtBase),
                            estimatedProfit: Number(opp.estimatedProfitUsd),
                            collateralAsset: opp.collateralAsset
                        });
                    }

                    checked++;
                    if (checked % 100 === 0) {
                        console.log(`✓ Analyzed ${checked}/${addresses.length} addresses`);
                    }
                }
            }

            return positions.sort((a, b) => b.estimatedProfit - a.estimatedProfit);
        } catch (error) {
            console.error('Error searching positions:', error);
            return [];
        }
    }

    async startMonitoring(interval: number = 60000) {
        console.log('🚀 Starting position monitoring...');
        let running = false;
        
        const checkPositions = async () => {
            if (running) return;
            running = true;
            
            try {
                const positions = await this.findLiquidatablePositions();
                if (positions.length > 0) {
                    console.log(`\n✅ Found ${positions.length} liquidatable positions:`);
                    positions.forEach(pos => {
                        console.log(`
                            👤 User: ${pos.user}
                            ❤️ Health Factor: ${pos.healthFactor}
                            💰 Estimated profit: $${pos.estimatedProfit.toFixed(2)}
                            🏦 Total collateral: ${pos.totalCollateralETH.toFixed(4)} ETH
                            💸 Total debt: ${pos.totalDebtETH.toFixed(4)} ETH
                        `);
                    });
                } else {
                    console.log('\n❌ No liquidatable positions found');
                }
            } finally {
                running = false;
            }
        };

        // First execution immediately
        await checkPositions();

        // Configurar el intervalo
        setInterval(checkPositions, interval);
    }
} 
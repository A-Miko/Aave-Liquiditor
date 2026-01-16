import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import axios from 'axios';
import { RpcProvider } from "./RpcProvider";

dotenv.config();

// Minimum ABI needed to query Aave Pool
const AAVE_POOL_ABI = [
    "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
    "function getReservesList() view returns (address[])",
    "function getReserveData(address asset) view returns (tuple(uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp) data)",
    "function getConfiguration(address asset) view returns (tuple(uint256 data) config)",
    "function getUserConfiguration(address user) view returns (tuple(uint256 data) config)"
];

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
    healthFactor: number;
    totalCollateralETH: number;
    totalDebtETH: number;
    estimatedProfit: number;
    collateralAsset?: string;
    liquidationBonus?: number;
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
  "function getPriceOracle() external view returns (address)"
];

const AAVE_ORACLE_ABI = [
  "function getAssetPrice(address asset) external view returns (uint256)",
  "function BASE_CURRENCY_UNIT() external view returns (uint256)"
];

export class PositionMonitor {
    private provider: ethers.AbstractProvider;
    private pool: ethers.Contract;
    private minHealthFactor: number;
    private minHealthFactorThreshold: number;
    private minProfitUSD: number;
    private addressesCache: Set<string>;
    private lastUpdate: number;
    private reservesList: string[] | null;
    private oracle: ethers.Contract | null = null;
    private highFrequencyHealthFactorCheck: number;
    private multicall: ethers.Contract;

    constructor() {
        const rpcProvider = new RpcProvider();
        this.provider = rpcProvider.getProvider();
        this.pool = new ethers.Contract(
            process.env.AAVE_LENDING_POOL || '',
            AAVE_POOL_ABI,
            this.provider
        );
        this.minHealthFactor = parseFloat(process.env.MIN_HEALTH_FACTOR || '1');
        this.minHealthFactorThreshold = parseFloat(process.env.MIN_HEALTH_FACTOR_THRESHOLD || '1.05');
        this.minProfitUSD = parseFloat(process.env.MIN_PROFIT_USD || '100');
        this.addressesCache = new Set<string>();
        this.lastUpdate = 0;
        this.reservesList = null;
        this.highFrequencyHealthFactorCheck = parseFloat(
            process.env.HIGH_FREQUENCY_HEALTH_FACTOR_CHECK || '1.01'
        );
        this.multicall = new ethers.Contract(MULTICALL3_ADDR, MULTICALL3_ABI, this.provider);
    }

    private async saveNormalWatchlistPlaceholder(args: { user: string; healthFactor: number }) {
        console.log(`📝 [normal-watchlist] user=${args.user} hf=${args.healthFactor}`);
    }

    private async saveHighFreqWatchlistPlaceholder(args: { user: string; healthFactor: number }) {
        console.log(`⚡ [highfreq-watchlist] user=${args.user} hf=${args.healthFactor}`);
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

                    const hf = parseFloat(ethers.formatUnits(accountData.healthFactor, 18));

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
                    const totalCollateralETH = parseFloat(ethers.formatUnits(accountData.totalCollateralBase, 18));
                    const totalDebtETH = parseFloat(ethers.formatUnits(accountData.totalDebtBase, 18));

                    const collateralAsset = await this.getUserCollateral(user);
                    if (!collateralAsset) continue;

                    const reserveConfig = await this.getReserveConfig(collateralAsset);
                    const liquidationBonus = reserveConfig.liquidationBonus / 100;

                    const maxLiquidation = totalDebtETH * 0.5;
                    const estimatedProfit = (maxLiquidation * liquidationBonus) - (maxLiquidation * 0.001);

                    const collateralPriceUSD = await this.getAssetPriceUSD(collateralAsset);
                    const estimatedProfitUSD = estimatedProfit * collateralPriceUSD;

                    if (estimatedProfitUSD < this.minProfitUSD) continue;

                    positions.push({
                        user,
                        healthFactor: hf,
                        totalCollateralETH,
                        totalDebtETH,
                        estimatedProfit: estimatedProfitUSD,
                        collateralAsset,
                        liquidationBonus: liquidationBonus * 100
                    });

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
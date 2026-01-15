import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import axios from 'axios';

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

const ADDRESSES_PROVIDER_ABI = [
  "function getPriceOracle() external view returns (address)"
];

const AAVE_ORACLE_ABI = [
  "function getAssetPrice(address asset) external view returns (uint256)",
  "function BASE_CURRENCY_UNIT() external view returns (uint256)"
];

export class PositionMonitor {
    private provider: ethers.JsonRpcProvider;
    private pool: ethers.Contract;
    private minHealthFactor: number;
    private minHealthFactorThreshold: number;
    private minProfitUSD: number;
    private addressesCache: Set<string>;
    private lastUpdate: number;
    private reservesList: string[] | null;
    private oracle: ethers.Contract | null = null;

    constructor() {
        this.provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC_URL);
        this.pool = new ethers.Contract(
            process.env.AAVE_LENDING_POOL || '',
            AAVE_POOL_ABI,
            this.provider
        );
        this.minHealthFactor = parseFloat(process.env.MIN_HEALTH_FACTOR || '1.1');
        this.minHealthFactorThreshold = parseFloat(process.env.MIN_HEALTH_FACTOR_THRESHOLD || '1.05');
        this.minProfitUSD = parseFloat(process.env.MIN_PROFIT_USD || '100');
        this.addressesCache = new Set<string>();
        this.lastUpdate = 0;
        this.reservesList = null;
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
            lastId = positions[positions.length - 1].id;;
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

    async findLiquidatablePositions(): Promise<Position[]> {
        try {
            const addresses = await this.getBorrowersFromSubgraph();
            const positions: Position[] = [];

            console.log(`🔍 Analyzing ${addresses.length} addresses...`);
            let checked = 0;

            for (const user of addresses) {
                try {
                    const {
                        totalCollateralBase,
                        totalDebtBase,
                        healthFactor
                    } = await this.pool.getUserAccountData(user);

                    const healthFactorNumber = parseFloat(ethers.formatUnits(healthFactor, 18));
                    
                    // 1) Store "near liquidation" range: [MIN_HEALTH_FACTOR, MIN_HEALTH_FACTOR_THRESHOLD)
                    if (
                        healthFactorNumber >= this.minHealthFactor &&
                        healthFactorNumber < this.minHealthFactorThreshold
                    ) {
                        // TODO: persist to DB (placeholder)
                        // await this.storeWatchlistCandidate({
                        //   user,
                        //   healthFactor: healthFactorNumber,
                        //   observedAt: new Date(),
                        // });
                        console.log(`📌 Near-liquidation: ${user} HF=${healthFactorNumber.toFixed(4)} (between ${this.minHealthFactor} and ${this.minHealthFactorThreshold})`);

                        // You probably don't want to run full profitability checks for these yet
                        continue;
                    }

                    // 2) Skip healthy positions (>= threshold)
                    if (healthFactorNumber >= this.minHealthFactorThreshold) continue;

                    // 3) Below MIN_HEALTH_FACTOR -> proceed with liquidatable/profit checks

                    const totalCollateralETH = parseFloat(ethers.formatUnits(totalCollateralBase, 18));
                    const totalDebtETH = parseFloat(ethers.formatUnits(totalDebtBase, 18));

                    // Get the asset used as collateral
                    const collateralAsset = await this.getUserCollateral(user);
                    if (!collateralAsset) continue;

                    // Get reserve configuration
                    const reserveConfig = await this.getReserveConfig(collateralAsset);
                    const liquidationBonus = reserveConfig.liquidationBonus / 100; // Convertir de porcentaje a decimal

                    // Calculate potential profit
                    const maxLiquidation = totalDebtETH * 0.5; // Maximum 50% of debt
                    const estimatedProfit = (maxLiquidation * liquidationBonus) - 
                        (maxLiquidation * 0.001); // 0.1% fee for flash loan

                    // Convert to USD using ETH price (approximate)
                    const collateralPriceUSD = await this.getAssetPriceUSD(collateralAsset);
                    const estimatedProfitUSD = estimatedProfit * collateralPriceUSD;

                    if (estimatedProfitUSD < this.minProfitUSD) continue;

                    positions.push({
                        user,
                        healthFactor: healthFactorNumber,
                        totalCollateralETH,
                        totalDebtETH,
                        estimatedProfit: estimatedProfitUSD,
                        collateralAsset,
                        liquidationBonus: liquidationBonus * 100 // Convert to percentage for display
                    });

                    checked++;
                    if (checked % 100 === 0) {
                        console.log(`✓ Analyzed ${checked}/${addresses.length} addresses`);
                    }
                } catch (error) {
                    // Ignore individual errors and continue with the next address
                    continue;
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
        
        const checkPositions = async () => {
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
        };

        // First execution immediately
        await checkPositions();

        // Configurar el intervalo
        setInterval(checkPositions, interval);
    }
} 
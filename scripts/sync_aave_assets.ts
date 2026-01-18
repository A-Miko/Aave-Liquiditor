import "dotenv/config";
import { Pool } from "pg";
import { ethers } from "ethers";

// Minimal ABIs
const AAVE_POOL_ABI = [
  "function getReservesList() view returns (address[])",
];

const AAVE_POOL_CONFIGURATOR_ABI = [
  // Returns (decimals, ltv, liquidationThreshold, liquidationBonus, reserveFactor, usageAsCollateralEnabled, borrowingEnabled, stableBorrowRateEnabled, isActive, isFrozen)
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
];

const ERC20_META_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

async function main() {
  const chainId = parseInt(process.env.CHAIN_ID ?? "42161", 10);

  const poolAddress = process.env.AAVE_LENDING_POOL;
  if (!poolAddress) throw new Error("Missing env AAVE_LENDING_POOL");

  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("Missing env RPC_URL");

  // Optional but recommended: config data via Aave configurator
  const configuratorAddress = process.env.AAVE_POOL_CONFIGURATOR || "";

  const db = new Pool({
    connectionString: `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  });

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const pool = new ethers.Contract(poolAddress, AAVE_POOL_ABI, provider);

  const configurator = configuratorAddress
    ? new ethers.Contract(configuratorAddress, AAVE_POOL_CONFIGURATOR_ABI, provider)
    : null;

  // Ensure chain exists (optional, but avoids FK issues if you start using chains table)
  await db.query(
    `
    INSERT INTO chains (chain_id, name, rpc_url)
    VALUES ($1, $2, $3)
    ON CONFLICT (chain_id) DO UPDATE SET rpc_url = EXCLUDED.rpc_url
    `,
    [chainId, process.env.CHAIN_NAME ?? `chain-${chainId}`, rpcUrl]
  );

  const reserves: string[] = (await pool.getReservesList()) as string[];
  console.log(`Found ${reserves.length} reserves on chain_id=${chainId}`);

  let upserted = 0;
  let failed = 0;

  for (const assetAddressRaw of reserves) {
    const assetAddress = assetAddressRaw.toLowerCase();

    try {
      const erc20 = new ethers.Contract(assetAddress, ERC20_META_ABI, provider);

      // Prefer configurator decimals if available (matches Aave’s view of the reserve),
      // else fallback to ERC20.decimals().
      let decimals: number | null = null;
      if (configurator) {
        const cfg = await configurator.getReserveConfigurationData(assetAddress);
        decimals = Number(cfg.decimals);
      } else {
        decimals = Number(await erc20.decimals());
      }

      let symbol: string | null = null;
      try {
        symbol = await erc20.symbol();
      } catch {
        symbol = null;
      }

      await db.query(
        `
        INSERT INTO assets (chain_id, asset_address, symbol, decimals)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (chain_id, asset_address)
        DO UPDATE SET
          symbol = COALESCE(EXCLUDED.symbol, assets.symbol),
          decimals = COALESCE(EXCLUDED.decimals, assets.decimals)
        `,
        [chainId, assetAddress, symbol, decimals]
      );

      upserted++;
      if (upserted % 20 === 0) {
        console.log(`Upserted ${upserted}/${reserves.length} assets...`);
      }
    } catch (e) {
      failed++;
      console.error(`Failed asset=${assetAddress}:`, e);
    }
  }

  console.log(`Done. upserted=${upserted}, failed=${failed}`);
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

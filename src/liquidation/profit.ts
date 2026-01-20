import { computeMaxRepay, type Bps } from "./math";

export type ProfitInputs = {
  debtAmount: bigint;
  collateralBalance: bigint;

  priceDebt: bigint;     // oracle units
  priceCol: bigint;      // oracle units
  baseUnit: bigint;      // oracle.BASE_CURRENCY_UNIT()

  closeFactorBps: Bps;       // e.g. 5000n
  liquidationBonusBps: Bps;  // e.g. 10500n

  // Optional cost model
  dexFeeBps?: Bps;       // e.g. 30n = 0.30%
  extraCostBase?: bigint; // e.g. gas or fixed buffer in base currency units

  debtDecimals: number;
  colDecimals: number;
};

export type ProfitResult = {
  repayAmount: bigint;
  profitBase: bigint;      // base currency units (same scaling as baseUnit)
  profitUsdApprox: number; // convenience only
};

export function evaluateProfit(args: ProfitInputs): ProfitResult {
  const {
    debtAmount,
    collateralBalance,
    priceDebt,
    priceCol,
    baseUnit,
    closeFactorBps,
    liquidationBonusBps,
    dexFeeBps = 0n,
    extraCostBase = 0n,
    debtDecimals,
    colDecimals,
  } = args;

  const repayAmount = computeMaxRepay({
    debtAmount,
    closeFactorBps,
    collateralBalance,
    priceDebt,
    priceCol,
    liquidationBonusBps,
    debtDecimals,
    colDecimals,
  });

  const repayValueBase = (repayAmount * priceDebt) / pow10(debtDecimals);

  // Apply liquidation bonus on VALUE
  const seizedValueBase = (repayValueBase * liquidationBonusBps) / 10_000n;

  // Fee on the repaid leg (simple model; adjust if you prefer fee on seized leg)
  const feeBase = (repayValueBase * dexFeeBps) / 10_000n;

  const profitBase = seizedValueBase - repayValueBase - feeBase - extraCostBase;

  return {
    repayAmount,
    profitBase,
    profitUsdApprox: Number(profitBase) / Number(baseUnit),
  };
}

function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

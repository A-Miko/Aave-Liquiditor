export type Bps = bigint;

export function minBigInt(a: bigint, b: bigint) {
  return a < b ? a : b;
}

/**
 * Computes max repay limited by closeFactor and by available collateral.
 * All values are BigInt; closeFactorBps/liquidationBonusBps are e.g. 5000n, 10500n.
 * priceDebt/priceCol must be in the same oracle units.
 */
export function computeMaxRepay(args: {
  debtAmount: bigint;
  closeFactorBps: Bps;          // e.g. 5000n = 50%
  collateralBalance: bigint;    // aToken balance (or underlying, but be consistent)
  priceDebt: bigint;
  priceCol: bigint;
  liquidationBonusBps: Bps;     // e.g. 10500n
  debtDecimals: number;
  colDecimals: number;
}): bigint {
  const { debtAmount, closeFactorBps, collateralBalance, priceDebt, priceCol, liquidationBonusBps, debtDecimals, colDecimals } = args;

  if (priceDebt <= 0n || priceCol <= 0n || liquidationBonusBps <= 0n || collateralBalance <= 0n) {
    throw new Error("priceDebt, priceCol, liquidationBonusBps and collateralBalance must be positive");
  }

  const maxByCloseFactor = (debtAmount * closeFactorBps) / 10_000n;

  const debtScale = pow10(debtDecimals);
  const colScale = pow10(colDecimals);

  // repay_raw <= collateral_raw * priceCol * 10000 * 10^debtDecimals
  //            / ( priceDebt * liquidationBonusBps * 10^colDecimals )
  const maxByCollateral =
    (collateralBalance * priceCol * 10_000n * debtScale) /
    (priceDebt * liquidationBonusBps * colScale);

  return minBigInt(maxByCloseFactor, maxByCollateral);
}

function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

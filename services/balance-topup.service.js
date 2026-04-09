const DEFAULT_BANKOMAT_FEE_PERCENT = 3;

function calculateBankomatNetAmount(amount, feePercent = DEFAULT_BANKOMAT_FEE_PERCENT) {
  const numericAmount = Number(amount || 0);
  const normalizedFeePercent = Number(feePercent);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) return 0;
  if (
    !Number.isFinite(normalizedFeePercent) ||
    normalizedFeePercent < 0 ||
    normalizedFeePercent >= 100
  ) {
    return 0;
  }
  return Math.floor((numericAmount * (100 - normalizedFeePercent)) / 100);
}

module.exports = {
  DEFAULT_BANKOMAT_FEE_PERCENT,
  calculateBankomatNetAmount,
};

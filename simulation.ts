import BN from "bignumber.js";

const ZERO = new BN(0);
const ONE = new BN(1);
const MINUTES_IN_YEAR = 365 * 24 * 60;

export class PriceProvider {
  currentPrice: BN;

  constructor(currentPrice: BN.Value) {
    this.currentPrice = new BN(currentPrice);
  }

  setPrice(newPrice: BN.Value) {
    this.currentPrice = new BN(newPrice);
  }
}

export class AMMPosition {
  constructor(
    public initialReserveX: BN,
    public initialReserveY: BN,
    public supplyInterest: BN,

    private readonly priceProvider: PriceProvider
  ) {}

  getReservesForCurrentPrice(): {
    reserveX: BN;
    reserveY: BN;
  } {
    const currentPrice = this.priceProvider.currentPrice;
    const k = this.initialReserveX.times(this.initialReserveY);

    const newReserveX = k.div(currentPrice).sqrt();
    const newReserveY = currentPrice.times(newReserveX);

    return { reserveX: newReserveX, reserveY: newReserveY };
  }

  estimatePositionValueInY() {
    const { reserveX, reserveY } = this.getReservesForCurrentPrice();
    const price = this.priceProvider.currentPrice;

    return reserveX.times(price).plus(reserveY);
  }

  generateYield(periodInMinutes: BN) {
    return this.estimatePositionValueInY()
      .times(this.supplyInterest)
      .times(periodInMinutes)
      .dividedBy(MINUTES_IN_YEAR);
  }
}

export class LendingPosition {
  constructor(
    public collateral: BN, // expected to be in USDT
    public debt: BN, // is expected to be in TON
    public liquidationThreshold: BN,
    public borrowingInterest: BN,
    public supplyInterest: BN,

    private readonly priceProvider: PriceProvider
  ) {}

  getDebtValue() {
    return this.debt.times(this.priceProvider.currentPrice);
  }

  estimatePositionValue() {
    return this.collateral.minus(this.getDebtValue());
  }

  get isLiquidatable() {
    return this.getDebtValue().gt(
      this.collateral.div(this.liquidationThreshold)
    );
  }

  get utilization() {
    return this.getDebtValue()
      .times(this.liquidationThreshold)
      .dividedBy(this.collateral);
  }

  accrueInterest(periodInMinutes: BN) {
    this.debt = this.debt
      .times(
        ONE.plus(
          this.borrowingInterest.times(periodInMinutes).div(MINUTES_IN_YEAR)
        )
      )
      .decimalPlaces(9, BN.ROUND_FLOOR);

    this.collateral = this.collateral
      .times(
        ONE.plus(
          this.supplyInterest.times(periodInMinutes).div(MINUTES_IN_YEAR)
        )
      )
      .decimalPlaces(6, BN.ROUND_FLOOR);

    if (this.isLiquidatable) {
      throw new Error("Liquidation just happened and we are broke :(", {
        cause: `${this.getDebtValue()} > ${this.collateral.div(
          this.liquidationThreshold
        )}`,
      });
    }
  }
}

export class Strategy {
  public ammPosition: AMMPosition;
  public lendingPosition: LendingPosition;
  public idealRatio: BN; // ideal ratio between AMM and lending
  public swapFee: BN; // fee for swapping tokens
  public interestPeriod: BN; // period for interest accrual
  public lastRebalancePrice: BN;

  public unusedTON: BN; // yield generated in TON
  public unusedUSDT: BN; // yield generated in USDT

  private readonly priceProvider: PriceProvider;

  public totalRebalances: number = 0;

  constructor(
    usdtToInvest: BN,
    ratio: BN,
    ammSupplyInterest: BN,
    borrowInterest: BN,
    supplyInterest: BN,
    liquidationThreshold: BN,
    initialPrice: BN,
    swapFee: BN,
    interestPeriod: BN
  ) {
    this.idealRatio = ratio;
    this.swapFee = swapFee;
    this.unusedTON = ZERO;
    this.unusedUSDT = ZERO;
    this.interestPeriod = interestPeriod;
    this.lastRebalancePrice = initialPrice;

    this.priceProvider = new PriceProvider(initialPrice);

    const ammReserveY = usdtToInvest.times(ratio);
    const lendingCollateral = usdtToInvest.minus(ammReserveY);
    const amountToBorrow = ammReserveY.div(this.priceProvider.currentPrice);

    this.lendingPosition = new LendingPosition(
      lendingCollateral,
      amountToBorrow,
      liquidationThreshold,
      borrowInterest,
      supplyInterest,
      this.priceProvider
    );

    this.ammPosition = new AMMPosition(
      amountToBorrow,
      ammReserveY,
      ammSupplyInterest,
      this.priceProvider
    );
  }

  nextPrice(newPrice: number) {
    this.priceProvider.setPrice(newPrice);
    this.lendingPosition.accrueInterest(this.interestPeriod);

    // We assume that the AMM is generating yield in the USDT tokens
    const yieldGenerated = this.ammPosition.generateYield(this.interestPeriod);
    this.unusedUSDT = this.unusedUSDT.plus(yieldGenerated);

    const deviations = this.computeDeviationFromIdealSetup();
    const deviationRatio = deviations.deviationAmmReserveY
      .div(this.ammPosition.getReservesForCurrentPrice().reserveY)
      .abs();

    if (deviationRatio.gt(0.1)) {
      this.rebalance();
      this.lastRebalancePrice = this.priceProvider.currentPrice;
    }
  }

  rebalance() {
    const valueBeforeRebalance = this.estimateTotalStrategyValue();

    this.withdrawExcessesFromAMM();
    this.withdrawExcessesFromLendingCollateral();
    this.coverOutstandingBorrowedAmount();
    this.coverOutstandingCollateral();
    this.borrowUntilIdealSetup();
    this.addOutstandingLiquidityToAMM();

    const valueAfterRebalance = this.estimateTotalStrategyValue();
    this.totalRebalances++;

    // Sanity check: the total value should not increase after rebalance
    if (valueAfterRebalance.gt(valueBeforeRebalance.plus(0.00001))) {
      throw new Error(
        `Rebalance led to system incosistency: ${valueBeforeRebalance} != ${valueAfterRebalance}`
      );
    }
  }

  coverAmountWithUSDT(amount: BN) {
    let covered = BN.min(this.unusedUSDT, amount);

    const leftUsdtToCover = amount.minus(covered);
    this.unusedUSDT = this.unusedUSDT.minus(covered);

    const swapFee = ONE.minus(this.swapFee);

    const tonToSwap = BN.min(
      this.unusedTON,
      leftUsdtToCover
        .dividedBy(this.priceProvider.currentPrice)
        .dividedBy(swapFee)
    );

    this.unusedTON = this.unusedTON.minus(tonToSwap);

    const swapOutput = tonToSwap
      .times(swapFee)
      .times(this.priceProvider.currentPrice);

    covered = covered.plus(swapOutput);

    return covered;
  }

  coverAmountWithTON(amount: BN) {
    let covered = BN.min(this.unusedTON, amount);

    const leftTonToCover = amount.minus(covered);
    this.unusedTON = this.unusedTON.minus(covered);

    const swapFee = ONE.minus(this.swapFee);

    const usdtToSwap = BN.min(
      this.unusedUSDT,
      leftTonToCover.times(this.priceProvider.currentPrice).div(swapFee)
    );

    this.unusedUSDT = this.unusedUSDT.minus(usdtToSwap);
    const swapOutput = usdtToSwap
      .times(swapFee)
      .div(this.priceProvider.currentPrice);

    covered = covered.plus(swapOutput);

    return covered;
  }

  coverOutstandingCollateral() {
    const deviations = this.computeDeviationFromIdealSetup();

    if (deviations.deviationLendingCollateral.lt(0)) {
      const amountToCover = deviations.deviationLendingCollateral.abs();

      const covered = this.coverAmountWithUSDT(amountToCover);
      this.lendingPosition.collateral =
        this.lendingPosition.collateral.plus(covered);

      console.log("Covered collateral: ", covered);
    }
  }

  coverOutstandingBorrowedAmount() {
    const deviations = this.computeDeviationFromIdealSetup();

    if (deviations.deviationAmountToBorrow.gt(0)) {
      const amountToCover = deviations.deviationAmountToBorrow.abs();

      const covered = this.coverAmountWithTON(amountToCover);
      this.lendingPosition.debt = this.lendingPosition.debt.minus(covered);

      console.log("Covered borrowed amount: ", covered);
    }
  }

  addOutstandingLiquidityToAMM() {
    const deviations = this.computeDeviationFromIdealSetup();
    const deviationRatio = deviations.deviationAmmReserveY.div(
      this.ammPosition.getReservesForCurrentPrice().reserveY
    );

    if (deviationRatio.lt(-0.05)) {
      const { reserveX, reserveY } =
        this.ammPosition.getReservesForCurrentPrice();

      const idealReserveY = reserveY.minus(deviations.deviationAmmReserveY);
      const idealReserveX = reserveX.times(idealReserveY).div(reserveY);

      let outstandingX = idealReserveX.minus(reserveX);
      let outstandingY = idealReserveY.minus(reserveY);

      const totalUnused = this.estimateUnusedFundsValue().times(
        ONE.minus(this.swapFee)
      ); // multiplied by (1 - swapFee) to account for the potential swap fee

      const totalOutstanding = outstandingX
        .times(this.priceProvider.currentPrice)
        .plus(outstandingY);

      if (totalUnused < totalOutstanding) {
        const ratio = totalUnused.div(totalOutstanding);
        outstandingX = outstandingX.times(ratio);
        outstandingY = outstandingY.times(ratio);
      }

      const availableX = this.coverAmountWithTON(outstandingX);
      const availableY = this.coverAmountWithUSDT(outstandingY);

      const price = availableY.div(availableX);
      if (!areValuesClose(price, this.priceProvider.currentPrice)) {
        throw new Error(
          `System is fucked up ${price} != ${this.priceProvider.currentPrice}`
        );
      }

      this.ammPosition.initialReserveX = reserveX.plus(availableX);
      this.ammPosition.initialReserveY = reserveY.plus(availableY);
    }
  }

  withdrawExcessesFromAMM() {
    const deviations = this.computeDeviationFromIdealSetup();

    // @todo add more sophisticated conditions for withdrawing
    if (deviations.deviationAmmReserveY.gt(0)) {
      const { reserveX, reserveY } =
        this.ammPosition.getReservesForCurrentPrice();

      const idealReserveY = reserveY.minus(deviations.deviationAmmReserveY);
      const idealReserveX = reserveX.times(idealReserveY).div(reserveY);

      this.ammPosition.initialReserveX = idealReserveX;
      this.ammPosition.initialReserveY = idealReserveY;

      const freeX = reserveX.minus(idealReserveX);
      const freeY = reserveY.minus(idealReserveY);

      this.unusedTON = this.unusedTON.plus(freeX);
      this.unusedUSDT = this.unusedUSDT.plus(freeY);
    }
  }

  withdrawExcessesFromLendingCollateral() {
    const deviations = this.computeDeviationFromIdealSetup();

    // @todo add more sophisticated conditions for withdrawing
    if (deviations.deviationLendingCollateral.gt(0)) {
      const amountToWithdraw = deviations.deviationLendingCollateral;

      this.lendingPosition.collateral =
        this.lendingPosition.collateral.minus(amountToWithdraw);
      this.unusedUSDT = this.unusedUSDT.plus(amountToWithdraw);
    }
  }

  borrowUntilIdealSetup() {
    const deviations = this.computeDeviationFromIdealSetup();

    // @todo add more sophisticated conditions for borrowing
    if (deviations.deviationAmountToBorrow.lt(0)) {
      const toBorrow = deviations.deviationAmountToBorrow.abs();
      this.lendingPosition.debt = this.lendingPosition.debt.plus(toBorrow);
      this.unusedTON = this.unusedTON.plus(toBorrow);
    }
  }

  estimateUnusedFundsValue() {
    return this.unusedTON
      .times(this.priceProvider.currentPrice)
      .plus(this.unusedUSDT);
  }

  estimateTotalStrategyValue() {
    return this.lendingPosition
      .estimatePositionValue()
      .plus(this.ammPosition.estimatePositionValueInY())
      .plus(this.estimateUnusedFundsValue());
  }

  computeIdealSetupForCurrentPrice() {
    const totalValue = this.estimateTotalStrategyValue();
    const idealAmmReserveY = totalValue.times(this.idealRatio);
    const idealLendingCollateral = totalValue.minus(idealAmmReserveY);
    const idealAmountToBorrow = idealAmmReserveY.div(
      this.priceProvider.currentPrice
    );

    return {
      idealLendingCollateral,
      idealAmountToBorrow,
      idealAmmReserveY,
    };
  }

  computeDeviationFromIdealSetup() {
    const { idealLendingCollateral, idealAmountToBorrow, idealAmmReserveY } =
      this.computeIdealSetupForCurrentPrice();

    const currentAmmReserveY =
      this.ammPosition.getReservesForCurrentPrice().reserveY;
    const currentLendingCollateral = this.lendingPosition.collateral;
    const currentAmountToBorrow = this.lendingPosition.debt;

    return {
      deviationAmmReserveY: currentAmmReserveY.minus(idealAmmReserveY),
      deviationLendingCollateral: currentLendingCollateral.minus(
        idealLendingCollateral
      ),
      deviationAmountToBorrow: currentAmountToBorrow.minus(idealAmountToBorrow),
    };
  }

  logStatus() {
    const ideal = this.computeIdealSetupForCurrentPrice();
    const deviations = this.computeDeviationFromIdealSetup();
    const logData = {
      Price: this.priceProvider.currentPrice,
      "Lending Total Locked": this.lendingPosition.estimatePositionValue(),
      "Lending Collateral Value": this.lendingPosition.collateral,
      "Lending Borrowed Amount": this.lendingPosition.debt,
      "Lending Debt Value": this.lendingPosition.getDebtValue(),
      "Lending Utilization": this.lendingPosition.utilization,
      "AMM Locked Value": this.ammPosition.estimatePositionValueInY(),
      "AMM Reserve X": this.ammPosition.getReservesForCurrentPrice().reserveX,
      "AMM Reserve Y": this.ammPosition.getReservesForCurrentPrice().reserveY,
      "Total Strategy Value": this.estimateTotalStrategyValue(),
      "Unused TON": this.unusedTON,
      "Unused USDT": this.unusedUSDT,
      "Ideal Lending Collateral Value": ideal.idealLendingCollateral,
      "Ideal Borrowed Amount": ideal.idealAmountToBorrow,
      "Ideal AMM Reserve Y": ideal.idealAmmReserveY,
      "Deviation AMM Reserve Y": deviations.deviationAmmReserveY,
      "Deviation Lending Collateral": deviations.deviationLendingCollateral,
      "Deviation Borrowed Amount": deviations.deviationAmountToBorrow,
      "Last rebalance price": this.lastRebalancePrice,
      "Total rebalances": this.totalRebalances,
    };

    return logData;
  }
}

function areValuesClose(a: BN, b: BN, threshold = 0.001) {
  return a.minus(b).abs().lt(threshold);
}

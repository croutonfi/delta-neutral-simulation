export class PriceProvider {
  currentPrice: number;

  constructor(currentPrice: number) {
    this.currentPrice = currentPrice;
  }

  setPrice(newPrice: number) {
    this.currentPrice = newPrice;
  }
}

export class AMMPosition {
  constructor(
    public initialReserveX: number,
    public initialReserveY: number,
    public supplyInterest: number,

    private readonly priceProvider: PriceProvider
  ) {}

  getReservesForCurrentPrice(): {
    reserveX: number;
    reserveY: number;
  } {
    const currentPrice = this.priceProvider.currentPrice;
    const k = this.initialReserveX * this.initialReserveY;

    const newReserveX = Math.sqrt(k / currentPrice);
    const newReserveY = currentPrice * newReserveX;

    return { reserveX: newReserveX, reserveY: newReserveY };
  }

  estimatePositionValueInY() {
    const { reserveX, reserveY } = this.getReservesForCurrentPrice();
    const price = this.priceProvider.currentPrice;

    return reserveX * price + reserveY;
  }

  generateDailyYield() {
    const positionValue = this.estimatePositionValueInY();
    return ((positionValue * this.supplyInterest) / 365 / 24 / 60) * 5;
  }
}

export class LendingPosition {
  constructor(
    public collateral: number, // expected to be in USDT
    public debt: number, // is expected to be in TON
    public liquidationThreshold: number,
    public borrowingInterest: number,
    public supplyInterest: number,

    private readonly priceProvider: PriceProvider
  ) {}

  getDebtValue() {
    return this.debt * this.priceProvider.currentPrice;
  }

  estimatePositionValue() {
    return this.collateral - this.getDebtValue();
  }

  get isLiquidatable() {
    return this.getDebtValue() > this.collateral / this.liquidationThreshold;
  }

  get utilization() {
    return (this.getDebtValue() * this.liquidationThreshold) / this.collateral;
  }

  accrueDailyInterest() {
    this.debt *= 1 + (this.borrowingInterest / 365 / 24 / 60) * 5;
    this.collateral *= 1 + (this.supplyInterest / 365 / 24 / 60) * 5;

    if (this.isLiquidatable) {
      throw new Error("Liquidation just happened and we are broke :(", {
        cause: `${this.getDebtValue()} > ${
          this.collateral / this.liquidationThreshold
        }`,
      });
    }
  }
}

export class Strategy {
  public idealRatio: number; // ideal ratio between AMM and lending
  public ammPosition: AMMPosition;
  public lendingPosition: LendingPosition;
  public swapFee: number; // fee for swapping tokens

  public unusedTON: number; // yield generated in TON
  public unusedUSDT: number; // yield generated in USDT

  private readonly priceProvider: PriceProvider;
  public totalRebalances: number = 0;

  constructor(
    usdtToInvest: number,
    ratio: number,
    ammSupplyInterest: number,
    borrowInterest: number,
    supplyInterest: number,
    liquidationThreshold: number,
    initialPrice: number,
    swapFee: number = 0.005
  ) {
    this.idealRatio = ratio;
    this.swapFee = swapFee;
    this.unusedTON = 0;
    this.unusedUSDT = 0;

    this.priceProvider = new PriceProvider(initialPrice);

    const ammReserveY = usdtToInvest * ratio;
    const lendingCollateral = usdtToInvest - ammReserveY;
    const amountToBorrow = ammReserveY / this.priceProvider.currentPrice;

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
    this.lendingPosition.accrueDailyInterest();

    // We assume that the AMM is generating yield in the USDT tokens
    const yieldGenerated = this.ammPosition.generateDailyYield();
    this.unusedUSDT += yieldGenerated;

    const deviations = this.computeDeviationFromIdealSetup();

    if (
      Math.abs(
        deviations.deviationAmmReserveY /
          this.ammPosition.getReservesForCurrentPrice().reserveY
      ) > 0.1
    ) {
      this.rebalance();
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
    if (valueAfterRebalance > valueBeforeRebalance + 0.00001) {
      throw new Error(
        `Rebalance led to system incosistency: ${valueBeforeRebalance} != ${valueAfterRebalance}`
      );
    }
  }

  useUnusedUSDT(amount: number) {
    let covered = Math.min(this.unusedUSDT, amount);
    let leftUsdtToCover = amount - covered;
    this.unusedUSDT -= covered;

    let swapFee = 1 - this.swapFee;

    let tonToSwap = Math.min(
      this.unusedTON,
      leftUsdtToCover / this.priceProvider.currentPrice / swapFee
    );

    this.unusedTON -= tonToSwap;
    covered += swapFee * tonToSwap * this.priceProvider.currentPrice;

    return covered;
  }

  useUnusedTON(amount: number) {
    let covered = Math.min(this.unusedTON, amount);
    let leftTonToCover = amount - covered;
    this.unusedTON -= covered;

    let swapFee = 1 - this.swapFee;

    let usdtToSwap = Math.min(
      this.unusedUSDT,
      (leftTonToCover * this.priceProvider.currentPrice) / swapFee
    );

    this.unusedUSDT -= usdtToSwap;
    covered += (swapFee * usdtToSwap) / this.priceProvider.currentPrice;

    return covered;
  }

  coverOutstandingCollateral() {
    const deviations = this.computeDeviationFromIdealSetup();

    if (deviations.deviationLendingCollateral < 0) {
      const amountToCover = Math.abs(deviations.deviationLendingCollateral);

      const covered = this.useUnusedUSDT(amountToCover);
      this.lendingPosition.collateral += covered;

      console.log("Covered collateral: ", covered);
    }
  }

  coverOutstandingBorrowedAmount() {
    const deviations = this.computeDeviationFromIdealSetup();

    if (deviations.deviationAmountToBorrow > 0) {
      const amountToCover = Math.abs(deviations.deviationAmountToBorrow);

      const covered = this.useUnusedTON(amountToCover);
      this.lendingPosition.debt -= covered;

      console.log("Covered borrowed amount: ", covered);
    }
  }

  addOutstandingLiquidityToAMM() {
    const deviations = this.computeDeviationFromIdealSetup();

    if (
      deviations.deviationAmmReserveY /
        this.ammPosition.getReservesForCurrentPrice().reserveY <
      -0.05
    ) {
      const { reserveX, reserveY } =
        this.ammPosition.getReservesForCurrentPrice();

      const idealReserveY = reserveY - deviations.deviationAmmReserveY;
      const idealReserveX = reserveX * (idealReserveY / reserveY);

      let outstandingX = idealReserveX - reserveX;
      let outstandingY = idealReserveY - reserveY;

      const totalUnused = this.estimateUnusedFundsValue() * (1 - this.swapFee); // multiplied by (1 - swapFee) to account for the potential swap fee
      const totalOutstanding =
        outstandingX * this.priceProvider.currentPrice + outstandingY;

      if (totalUnused < totalOutstanding) {
        const ratio = totalUnused / totalOutstanding;
        outstandingX *= ratio;
        outstandingY *= ratio;
      }

      const availableX = this.useUnusedTON(outstandingX);
      const availableY = this.useUnusedUSDT(outstandingY);

      const price = availableY / availableX;
      if (!areValuesClose(price, this.priceProvider.currentPrice)) {
        throw new Error(
          `System is fucked up ${price} != ${this.priceProvider.currentPrice}`
        );
      }

      this.ammPosition.initialReserveX = reserveX + availableX;
      this.ammPosition.initialReserveY = reserveY + availableY;
    }
  }

  withdrawExcessesFromAMM() {
    const deviations = this.computeDeviationFromIdealSetup();

    // @todo add more sophisticated conditions for withdrawing
    if (deviations.deviationAmmReserveY > 0) {
      const { reserveX, reserveY } =
        this.ammPosition.getReservesForCurrentPrice();

      const idealReserveY = reserveY - deviations.deviationAmmReserveY;
      const idealReserveX = reserveX * (idealReserveY / reserveY);

      this.ammPosition.initialReserveX = idealReserveX;
      this.ammPosition.initialReserveY = idealReserveY;

      const freeX = reserveX - idealReserveX;
      const freeY = reserveY - idealReserveY;

      this.unusedTON += freeX;
      this.unusedUSDT += freeY;
    }
  }

  withdrawExcessesFromLendingCollateral() {
    const deviations = this.computeDeviationFromIdealSetup();

    // @todo add more sophisticated conditions for withdrawing
    if (deviations.deviationLendingCollateral > 0) {
      const amountToWithdraw = deviations.deviationLendingCollateral;

      this.lendingPosition.collateral -= amountToWithdraw;
      this.unusedUSDT += amountToWithdraw;
    }
  }

  borrowUntilIdealSetup() {
    const deviations = this.computeDeviationFromIdealSetup();

    // @todo add more sophisticated conditions for borrowing
    if (deviations.deviationAmountToBorrow < 0) {
      const toBorrow = Math.abs(deviations.deviationAmountToBorrow);
      this.lendingPosition.debt += toBorrow;
      this.unusedTON += toBorrow;
    }
  }

  estimateUnusedFundsValue() {
    return this.unusedTON * this.priceProvider.currentPrice + this.unusedUSDT;
  }

  estimateTotalStrategyValue() {
    return (
      this.lendingPosition.estimatePositionValue() +
      this.ammPosition.estimatePositionValueInY() +
      this.estimateUnusedFundsValue()
    );
  }

  computeIdealSetupForCurrentPrice() {
    const totalValue = this.estimateTotalStrategyValue();
    const idealAmmReserveY = totalValue * this.idealRatio;
    const idealLendingCollateral = totalValue - idealAmmReserveY;
    const idealAmountToBorrow =
      idealAmmReserveY / this.priceProvider.currentPrice;

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
      deviationAmmReserveY: currentAmmReserveY - idealAmmReserveY,
      deviationLendingCollateral:
        currentLendingCollateral - idealLendingCollateral,
      deviationAmountToBorrow: currentAmountToBorrow - idealAmountToBorrow,
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
    };

    console.table(logData);

    return logData;
  }
}

function areValuesClose(a: number, b: number, threshold = 0.001) {
  return Math.abs(a - b) < threshold;
}

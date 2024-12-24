import BN from "bignumber.js";

BN.config({ DECIMAL_PLACES: 9, ROUNDING_MODE: BN.ROUND_DOWN });

import { writeFileSync } from "fs";
import { readPricesBinance } from "./prices";
import { Strategy } from "./simulation";
import {
  convertToReadableObject,
  createCsvHeader,
  createCsvRow,
} from "./utils";

const USDT_TO_INVEST = new BN(1_000_000);
const RATIO = new BN("0.33");
const BORROW_INTEREST = new BN("0.02");
const SUPPLY_INTEREST = new BN("0.08");
const AMM_SUPPLY_INTEREST = new BN("0.2");
const LIQUIDATION_THRESHOLD = new BN("1.25");
const SWAP_FEE = new BN("0.01");
const INTEREST_PERIOD_MINUTES = new BN(5);

const allPrices = readPricesBinance();
// .filter(
//   (p) => p.date.includes("2024") || p.date.includes("2023")
// );

const START_PRICE = new BN(allPrices[0].price);

const strategy = new Strategy(
  USDT_TO_INVEST,
  RATIO,
  AMM_SUPPLY_INTEREST,
  BORROW_INTEREST,
  SUPPLY_INTEREST,
  LIQUIDATION_THRESHOLD,
  START_PRICE,
  SWAP_FEE,
  INTEREST_PERIOD_MINUTES
);

const startingStatus = strategy.logStatus();

console.table(convertToReadableObject(startingStatus));

let csv = createCsvHeader(startingStatus);
csv += createCsvRow(allPrices[0].date, startingStatus);

for (let i = 0; i < allPrices.length; i++) {
  const { date, price } = allPrices[i];

  strategy.nextPrice(parseFloat(price));
  const logData = strategy.logStatus();

  if (i % 1000 === 0) {
    console.table(convertToReadableObject(logData));
  }

  csv += createCsvRow(date, logData);
}

console.table(convertToReadableObject(strategy.logStatus()));
console.log("Total rebalances:", strategy.totalRebalances);

writeFileSync("./simulation.csv", csv, {
  flush: true,
});

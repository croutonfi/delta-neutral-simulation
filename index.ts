import { writeFileSync } from "fs";
import { readPricesBinance } from "./prices";
import { Strategy } from "./simulation";

const USDT_TO_INVEST = 1000000;
const RATIO = 0.33;
const BORROW_INTEREST = 0.02;
const SUPPLY_INTEREST = 0.08;
const AMM_SUPPLY_INTEREST = 0.2;
const LIQUIDATION_THRESHOLD = 1.25;
const SWAP_FEE = 0.01;

const allPrices = readPricesBinance().filter(
  (p) => p.date.includes("2024") || p.date.includes("2023")
);

const startPrice = parseFloat(allPrices[0].price);

const strategy = new Strategy(
  USDT_TO_INVEST,
  RATIO,
  AMM_SUPPLY_INTEREST,
  BORROW_INTEREST,
  SUPPLY_INTEREST,
  LIQUIDATION_THRESHOLD,
  startPrice,
  SWAP_FEE
);

let csv = "";
const startingStatus = strategy.logStatus();

csv += "Date," + Object.keys(startingStatus).join(",") + "\n";
csv += allPrices[0].date + "," + Object.values(startingStatus).join(",") + "\n";

for (let i = 0; i < allPrices.length; i++) {
  const { date, price } = allPrices[i];

  console.info("iteration: ", i, "price: ", price, "date: ", date);

  strategy.nextPrice(parseFloat(price));

  // csv += `${date},${Object.values(iterationStatus).join(",")}` + "\n";
}

const iterationStatus = strategy.logStatus();
console.log(allPrices[0].date, allPrices[allPrices.length - 1].date, iterationStatus);

writeFileSync("./simulation.csv", csv, {
  flush: true,
});

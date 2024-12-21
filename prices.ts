import fs from "fs";

export function readPrices(fileName = "./prices/ton-prices.csv") {
  const file = fs.readFileSync(fileName, "utf8");

  const list = file.split("\n");

  const [_, ...data] = list
    .map((item) => {
      const [date, price] = item.split(",");
      return { date, price };
    })
    .filter((item) => !!item.price);

  return data;
}

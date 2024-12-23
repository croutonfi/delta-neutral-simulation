import fs from "fs";

type BinancePriceEntry = {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteVolume: string;
  trades: number;
  baseAssetVolume: string;
  quoteAssetVolume: string;
};

export function readCsvPrices(fileName = "./prices/ton-prices.csv") {
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

export function readPricesBinance(
  fileName = "./prices/binance-eth-prices.json"
) {
  const file = fs.readFileSync(fileName, "utf8");
  const list: BinancePriceEntry[] = JSON.parse(file);

  return list.map((item) => {
    return {
      date: new Date(item.closeTime).toISOString(),
      price: item.close,
    };
  });
}

import Binance from "binance-api-node";
import fs from "fs";
import path from "path";

const filePath = path.resolve(__dirname, "binance-ton-prices.json");

const fileJson = fs.readFileSync(filePath, "utf8");
const data = JSON.parse(fileJson);

let lastCandleCloseTime = data[data.length - 1]?.closeTime || 0;

const binance = Binance({
  apiKey: "",
  apiSecret: "",
});

console.log("Starting download from: ", lastCandleCloseTime, "Data length: ", data.length);

while (true) {
  const candles = await binance.candles({
    symbol: "TONUSDT",
    interval: "5m",
    limit: 1000,
    startTime: lastCandleCloseTime,
  });

  if (candles.length === 0) {
    break;
  }

  data.push(...candles);
  lastCandleCloseTime = data[data.length - 1].closeTime;
  console.log("New data length: ", data.length, "Last candle close time: ", new Date(lastCandleCloseTime).toDateString());
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

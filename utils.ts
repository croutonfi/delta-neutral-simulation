import BN from "bignumber.js";

export function convertToReadableObject(input: Record<string, BN.Value>) {
  return Object.entries(input).reduce((acc, [key, value]) => {
    return {
      ...acc,
      [key]: value.toString(),
    };
  }, {});
}

export function createCsvHeader(input: Record<string, BN.Value>) {
  const keys = Object.keys(convertToReadableObject(input));
  return `Date,${keys.join(",")}\n`;
}

export function createCsvRow(date: string, input: Record<string, BN.Value>) {
  const values = Object.values(convertToReadableObject(input));
  return `${date},${values.join(",")}\n`;
}

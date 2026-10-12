import type { TokenUsage } from "./types.js";

export const API_PRICE_SOURCE_URL = "https://developers.openai.com/api/docs/pricing";
export const API_PRICES_CHECKED_ON = "2026-10-12";
export const API_PRICE_BASIS = "Standard short-context API rates (USD per 1M tokens); gpt-5.6-luna uses the user-provided 2× gpt-6-luna estimate";

export type ApiPricePerMillionUsd = {
  input: number;
  cachedInput: number;
  output: number;
};

type ModelUsageRow = TokenUsage & { name: string; sessionCount: number };

const apiPrices: Readonly<Record<string, ApiPricePerMillionUsd>> = {
  "gpt-6.1-sol": { input: 2, cachedInput: 0.1, output: 10 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1 },
  "gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.6-cyber": { input: 12.5, cachedInput: 1.25, output: 75 },
};

export function addApiPriceEstimates<T extends ModelUsageRow>(rows: T[]) {
  const models = rows.map((row) => {
    const price = apiPrices[row.name.trim().toLowerCase()];
    const cacheHitRate = row.inputTokens === 0 ? null : row.cachedInputTokens / row.inputTokens * 100;
    const uncachedInputRate = row.inputTokens === 0 ? null : row.uncachedInputTokens / row.inputTokens * 100;
    const billableCachedInput = Math.min(row.cachedInputTokens, row.inputTokens);
    const billableUncachedInput = Math.max(0, row.inputTokens - billableCachedInput);
    const estimatedApiCostUsd = price === undefined ? null : (
      billableUncachedInput * price.input
      + billableCachedInput * price.cachedInput
      + row.outputTokens * price.output
    ) / 1_000_000;

    return {
      ...row,
      cacheHitRate,
      uncachedInputRate,
      estimatedApiCostUsd,
      ...(price ? { apiPricePerMillionUsd: price } : {}),
    };
  });
  const pricedModels = models.filter((model) => model.estimatedApiCostUsd !== null);

  return {
    models,
    apiCost: {
      estimatedUsd: pricedModels.reduce((sum, model) => sum + model.estimatedApiCostUsd!, 0),
      pricedModelCount: pricedModels.length,
      totalModelCount: models.length,
      status: models.length === 0 ? "unavailable" : pricedModels.length === models.length ? "complete" : pricedModels.length > 0 ? "partial" : "unavailable",
      unpricedModels: models.filter((model) => model.estimatedApiCostUsd === null).map((model) => model.name),
      assumedPriceModels: models.filter((model) => model.name.trim().toLowerCase() === "gpt-5.6-luna").map((model) => model.name),
      sourceUrl: API_PRICE_SOURCE_URL,
      checkedOn: API_PRICES_CHECKED_ON,
      basis: API_PRICE_BASIS,
    },
  };
}

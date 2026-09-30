import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getAllowedSubagentModels,
  getSupportedThinkingLevels,
  validateSubagentModelSelection,
} from "../src/model-selection.ts";

const reasoningModel = {
  provider: "openai",
  id: "o3",
  name: "O3",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

const textModel = {
  provider: "anthropic",
  id: "haiku",
  name: "Haiku",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
};

describe("subagent model selection", () => {
  it("uses scoped models when available and otherwise uses authenticated registry models", () => {
    const scoped = getAllowedSubagentModels(
      { scopedModels: [reasoningModel], modelRegistry: { getAvailable: () => [textModel] } },
      "openai",
    );
    assert.deepEqual(scoped.map(({ provider, id }) => `${provider}/${id}`), ["openai/o3"]);

    const available = getAllowedSubagentModels(
      { scopedModels: [], modelRegistry: { getAvailable: () => [textModel, reasoningModel] } },
      "openai",
    );
    assert.deepEqual(available.map(({ provider, id }) => `${provider}/${id}`), ["openai/o3", "anthropic/haiku"]);
  });

  it("shows thinking off for every model and reasoning levels only where supported", () => {
    assert.deepEqual(getSupportedThinkingLevels(textModel), ["off"]);
    assert.deepEqual(getSupportedThinkingLevels(reasoningModel), ["off", "minimal", "low", "medium", "high"]);
    assert.deepEqual(
      getSupportedThinkingLevels({
        ...reasoningModel,
        thinkingLevelMap: { high: null, xhigh: "extended", max: "maximum" },
      }),
      ["off", "minimal", "low", "medium", "xhigh", "max"],
    );
  });

  it("requires exact allowed provider/model IDs and a supported explicit thinking level", () => {
    const models = [reasoningModel, textModel];
    assert.equal(validateSubagentModelSelection(models, "openai/o3", "high"), undefined);
    assert.equal(validateSubagentModelSelection(models, "anthropic/haiku", "off"), undefined);
    assert.match(validateSubagentModelSelection(models, "o3", "high") ?? "", /exact provider\/model ID/);
    assert.match(validateSubagentModelSelection(models, "openai/o3-extra", "high") ?? "", /not available/);
    assert.match(validateSubagentModelSelection(models, "anthropic/haiku", "high") ?? "", /does not support/);
    assert.match(validateSubagentModelSelection(models, "openai/o3", undefined) ?? "", /explicit thinking level/);
  });

  it("sorts the current provider first without excluding other providers", () => {
    const models = getAllowedSubagentModels(
      { scopedModels: [textModel, reasoningModel] },
      "openai",
    );
    assert.equal(models[0].provider, "openai");
    assert.equal(models.length, 2);
  });
});

/** A chat model that can be selected for a subagent spawn. */
export interface SubagentModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  thinkingLevelMap?: Record<string, string | null>;
}

/** Model context needed to list and validate available subagent models. */
export interface SubagentModelContext {
  scopedModels?: SubagentModel[];
  modelRegistry?: {
    getAvailable?: () => SubagentModel[];
  };
}

/** Task-complexity guidance applies only to these exact parent models. */
export function getSubagentDelegationGuidance(parentModel?: { provider: string; id: string }): string {
  if (!parentModel) return "";
  let everydayModel: string;
  let judgmentModel: string;
  if (parentModel.provider === "openai-codex" && parentModel.id === "gpt-6.1-sol") {
    everydayModel = "openai-codex/gpt-6-luna";
    judgmentModel = "openai-codex/gpt-6.1-sol";
  } else if (parentModel.provider === "anthropic" && parentModel.id === "claude-opus-5.5") {
    everydayModel = "anthropic/claude-sonnet-5.5";
    judgmentModel = "anthropic/claude-opus-5.5";
  } else {
    return "";
  }
  return (
    `Use ${everydayModel} subagents only for well-scoped everyday tasks, such as localized bug fixes and rapid feature iteration with clear acceptance criteria. ` +
    `For complex work requiring careful judgment, keep the work on the main agent or delegate to ${judgmentModel}. ` +
    `If uncertain, do not delegate to ${everydayModel}. ` +
    "If the recommended model is outside the current scope, keep the work on the main agent rather than substitute another model. " +
    "Explicit user requests override this guidance, but not scope restrictions."
  );
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Returns the models allowed to subagents, with the active provider listed first. */
export function getAllowedSubagentModels(
  ctx: SubagentModelContext,
  preferredProvider?: string,
): SubagentModel[] {
  const scopedModels = Array.isArray(ctx.scopedModels) ? ctx.scopedModels : [];
  const models =
    scopedModels.length > 0 ? scopedModels : (ctx.modelRegistry?.getAvailable?.() ?? []);
  const uniqueModels = new Map<string, SubagentModel>();
  for (const model of models) {
    if (model && typeof model.provider === "string" && typeof model.id === "string") {
      uniqueModels.set(`${model.provider}/${model.id}`, model);
    }
  }
  return [...uniqueModels.values()].sort((left, right) => {
    const leftPreferred = left.provider === preferredProvider ? 0 : 1;
    const rightPreferred = right.provider === preferredProvider ? 0 : 1;
    return (
      leftPreferred - rightPreferred ||
      left.provider.localeCompare(right.provider) ||
      left.id.localeCompare(right.id)
    );
  });
}

/** Lists the thinking levels supported by one model; off is always available. */
export function getSupportedThinkingLevels(model: SubagentModel): string[] {
  if (!model.reasoning) return ["off"];
  const thinkingLevelMap = model.thinkingLevelMap;
  if (thinkingLevelMap && Object.keys(thinkingLevelMap).length > 0) {
    return THINKING_LEVELS.filter((level) => {
      if (level === "off") return true;
      const mappedLevel = thinkingLevelMap[level];
      if (level === "xhigh" || level === "max") return typeof mappedLevel === "string";
      return mappedLevel !== null;
    });
  }
  return THINKING_LEVELS.filter((level) => level !== "xhigh" && level !== "max");
}

/** Rejects non-exact, unavailable, or unsupported subagent model selections. */
export function validateSubagentModelSelection(
  allowedModels: SubagentModel[],
  modelId: string | undefined,
  thinking: string | undefined,
): string | undefined {
  if (!modelId || modelId.indexOf("/") <= 0 || modelId.indexOf("/") === modelId.length - 1) {
    return "Select an exact provider/model ID from subagent_models.";
  }
  const model = allowedModels.find(({ provider, id }) => `${provider}/${id}` === modelId);
  if (!model) return `Model "${modelId}" is not available in the current model scope.`;
  if (!thinking) return "Select an explicit thinking level from subagent_models.";
  if (!getSupportedThinkingLevels(model).includes(thinking)) {
    return `Model "${modelId}" does not support thinking level "${thinking}".`;
  }
  return undefined;
}

/** Formats model capabilities and optional token pricing for the catalog tool. */
export function formatSubagentModelCatalog(models: SubagentModel[]): string {
  if (models.length === 0) {
    return "No authenticated chat models are available in the current model scope.";
  }
  return models
    .map((model) => {
      const id = `${model.provider}/${model.id}`;
      const name = model.name ? ` — ${model.name}` : "";
      const thinking = getSupportedThinkingLevels(model).join(", ");
      const cost = model.cost
        ? Object.entries(model.cost)
            .filter(([, value]) => Number.isFinite(value))
            .map(([key, value]) => `${key}=${value}`)
            .join(", ")
        : "";
      const pricing = cost ? `; pricing (USD per million tokens): ${cost}` : "";
      return `- ${id}${name}; thinking: ${thinking}${pricing}`;
    })
    .join("\n");
}

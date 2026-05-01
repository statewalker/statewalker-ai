import type { ModelRuntime } from "../../public/types.js";

export type ConnectionStatus = "untested" | "testing" | "connected" | "failed";

export type RuntimeShortName = "Remote" | "WebLLM" | "Transformers" | "llama.cpp";

export type RuntimeBadgeVariant = "informative" | "positive" | "neutral" | "negative";

export interface RuntimeMeta {
  shortName: RuntimeShortName;
  variant: RuntimeBadgeVariant;
  icon: string;
}

export type ModelRuntimeKey = ModelRuntime;

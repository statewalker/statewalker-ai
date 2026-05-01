import type { ModelDescriptor, ModelRuntime } from "../../public/types.js";
import type {
  ConnectionStatus,
  RuntimeBadgeVariant,
  RuntimeShortName,
} from "./providers.types.js";

export function runtimeShortName(runtime: ModelRuntime): RuntimeShortName {
  if (runtime === "remote") return "Remote";
  return "WebLLM";
}

export function runtimeBadgeVariant(runtime: ModelRuntime): RuntimeBadgeVariant {
  return runtime === "remote" ? "informative" : "positive";
}

export function engineRuntimeShortName(model: ModelDescriptor): RuntimeShortName {
  if (model.runtime === "remote") return "Remote";
  const id = model.providerId.toLowerCase();
  if (id.includes("webllm")) return "WebLLM";
  if (id.includes("tjs") || id.includes("transformers")) return "Transformers";
  if (id.includes("llama")) return "llama.cpp";
  return "WebLLM";
}

export function engineBadgeVariant(model: ModelDescriptor): RuntimeBadgeVariant {
  return model.runtime === "remote" ? "informative" : "positive";
}

/** Lucide icon name to render on a remote-provider sub-tab to surface
 *  the connection state. `undefined` means the tab has no icon. */
export function connectionStatusIcon(status: ConnectionStatus): string | undefined {
  switch (status) {
    case "connected":
      return "circle-check";
    case "testing":
      return "loader";
    case "failed":
      return "circle-x";
    default:
      return undefined;
  }
}

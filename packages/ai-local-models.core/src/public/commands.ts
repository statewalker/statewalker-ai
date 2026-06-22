import { Command, passthrough } from "@statewalker/shared-commands";

export interface SelectLocalModelPayload {
  /** Catalog key of the local model to activate (e.g.
   * `"local:smollm2-360m"`), or `undefined` to clear the local
   * selection. */
  modelId: string | undefined;
}

/**
 * Make a local model the active global selection. The
 * `ai-local-models` fragment handles this by writing
 * `ActiveModel{kind:"local"}`, persisting the active key, and kicking
 * off in-memory activation. Remote selections flow through `AiConfig`
 * + the chat-app projection, not this command.
 */
export const SelectLocalModelCommand = Command.silent("ai-local-models:select")
  .input(passthrough<SelectLocalModelPayload>())
  .output(passthrough<void>())
  .build();

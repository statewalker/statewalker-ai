/**
 * A model is named across AiConfig connections by the URI `connectionId:modelId`
 * — the {@link Connection} id, a colon, then the opaque model id (which may itself
 * contain `:` or `/`; the URI is split on the **first** colon only). This is the
 * Vercel AI SDK provider-registry convention, so the registry resolves it directly.
 * See `docs/adr/0001-model-reference-uri.md`.
 */
export interface ModelReference {
  connectionId: string;
  modelId: string;
}

/** Separator between the connection id and the model id in a reference URI. */
export const MODEL_REFERENCE_SEPARATOR = ":";

/** Whether a string is usable as a connection id in a reference URI (no separator). */
export function isValidConnectionId(connectionId: string): boolean {
  return connectionId.length > 0 && !connectionId.includes(MODEL_REFERENCE_SEPARATOR);
}

/**
 * Format a reference URI. Throws when the connection id is empty or contains the
 * separator (which would make the split ambiguous).
 */
export function formatModelReference(connectionId: string, modelId: string): string {
  if (!isValidConnectionId(connectionId)) {
    throw new Error(
      `Invalid connection id "${connectionId}": must be non-empty and contain no "${MODEL_REFERENCE_SEPARATOR}"`,
    );
  }
  return `${connectionId}${MODEL_REFERENCE_SEPARATOR}${modelId}`;
}

/**
 * Parse a reference URI, splitting on the FIRST separator so the model id keeps any
 * further `:` or `/`. Throws when no separator is present.
 */
export function parseModelReference(uri: string): ModelReference {
  const index = uri.indexOf(MODEL_REFERENCE_SEPARATOR);
  if (index < 0) {
    throw new Error(
      `Invalid model reference "${uri}": expected "connectionId${MODEL_REFERENCE_SEPARATOR}modelId"`,
    );
  }
  return {
    connectionId: uri.slice(0, index),
    modelId: uri.slice(index + MODEL_REFERENCE_SEPARATOR.length),
  };
}

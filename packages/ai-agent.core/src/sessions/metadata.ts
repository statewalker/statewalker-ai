export interface SessionModelRef {
  /** Connection id (from `Providers.config.connections[].id`), or the
   * literal `"local"` for a local model. */
  connectionId: string;
  /** Model id within the chosen Connection; for `"local"` this is the
   * catalog key (e.g. `"local:smollm2-360m"`). */
  modelId: string;
}

export interface SessionMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Per-session model selection. The chat composer's dropdown reads
   * and writes this; falls back to the workspace `ActiveModel` (the
   * last-selected hint) on new sessions or when the stored ref is
   * invalidated (Connection disconnected, model un-starred, etc.).
   * Older sessions stored before this field existed read as `undefined`
   * — they get the workspace hint on next render. */
  modelRef?: SessionModelRef;
}

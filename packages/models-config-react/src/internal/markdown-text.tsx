import { Markdown } from "@repo/chat-mini.chat-react";
import type { ReactElement } from "react";

interface MarkdownTextProps {
  props: { source: string };
}

/**
 * Bound to the `models-config` catalog's `Markdown` primitive.
 * Renders the source through chat-mini.chat-react's existing
 * `Markdown` component (the same pipeline used for chat message
 * bodies). Empty source renders nothing.
 */
export function MarkdownText({ props }: MarkdownTextProps): ReactElement | null {
  if (!props.source) return null;
  return <Markdown>{props.source}</Markdown>;
}

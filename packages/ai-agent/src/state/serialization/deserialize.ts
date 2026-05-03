import { parseProps, unescapeContent } from "./props.js";
import type { Node } from "./serialize.js";

const DELIMITER_RE = /^---+\s*$/;

/**
 * Stream-deserialize a sequence of markdown chunks into `{props, content}` nodes.
 *
 * Splits on lines matching `^---+\s*$`. Within each block, the first blank
 * line ends the props block; everything after is content (verbatim). If no
 * blank line appears in a block, the entire block is treated as props with
 * empty content.
 *
 * Accepts input split arbitrarily across chunks (mid-block, mid-line,
 * mid-delimiter); the scanner buffers across chunk boundaries.
 */
export async function* deserialize(
  chunks: Iterable<string> | AsyncIterable<string>,
): AsyncIterable<Node> {
  let buffer = "";
  let inBlock = false;
  let blockLines: string[] = [];

  const flushBlock = function* (): Generator<Node> {
    if (!inBlock) return;
    yield blockToNode(blockLines);
    blockLines = [];
    inBlock = false;
  };

  for await (const chunk of chunks) {
    buffer += chunk;
    // Process complete lines from buffer; keep the trailing partial line
    // in buffer for the next chunk.
    while (true) {
      const nlIdx = buffer.indexOf("\n");
      if (nlIdx === -1) break;
      const line = buffer.slice(0, nlIdx);
      buffer = buffer.slice(nlIdx + 1);
      if (DELIMITER_RE.test(line)) {
        yield* flushBlock();
        inBlock = true;
      } else if (inBlock) {
        blockLines.push(line);
      }
      // Lines outside any block (before the first delimiter) are discarded.
    }
  }
  // Process trailing partial line if any
  if (buffer.length > 0) {
    if (DELIMITER_RE.test(buffer)) {
      yield* flushBlock();
      inBlock = true;
    } else if (inBlock) {
      blockLines.push(buffer);
    }
  }
  yield* flushBlock();
}

function blockToNode(lines: string[]): Node {
  // Find the first blank line — separates props from content.
  let blankIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "") {
      blankIdx = i;
      break;
    }
  }
  let propsText: string;
  let contentLines: string[];
  if (blankIdx === -1) {
    // No blank line: whole block is props, content empty.
    propsText = lines.join("\n");
    contentLines = [];
  } else {
    propsText = lines.slice(0, blankIdx).join("\n");
    contentLines = lines.slice(blankIdx + 1);
  }
  const props = parseProps(propsText);
  // Strip a single trailing empty line introduced by the serializer's
  // unconditional trailing newline.
  if (contentLines.length > 0 && contentLines[contentLines.length - 1] === "") {
    contentLines = contentLines.slice(0, -1);
  }
  const content = unescapeContent(contentLines.join("\n"));
  return { props, content };
}

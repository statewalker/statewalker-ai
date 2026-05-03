// Props block helpers for the stream serializer.
// Format: zero or more `key=value` lines.
// Escapes inside values: `\\`, `\n`, `\=`.

const VALUE_ESC_RE = /[\\\n=]/g;
const VALUE_UNESC_RE = /\\([\\n=])/g;

function escapeValue(value: string): string {
  return value.replace(VALUE_ESC_RE, (ch) => {
    if (ch === "\\") return "\\\\";
    if (ch === "\n") return "\\n";
    return "\\=";
  });
}

function unescapeValue(value: string): string {
  return value.replace(VALUE_UNESC_RE, (_, ch) => {
    if (ch === "n") return "\n";
    return ch as string;
  });
}

export function serializeProps(props: Record<string, string>): string {
  const out: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    out.push(`${key}=${escapeValue(value)}`);
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

export function parseProps(text: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line === "") continue;
    // Current format: first unescaped `=`.
    let eqIdx = -1;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "=" && (i === 0 || line[i - 1] !== "\\")) {
        eqIdx = i;
        break;
      }
    }
    if (eqIdx > 0) {
      const key = line.slice(0, eqIdx);
      const value = unescapeValue(line.slice(eqIdx + 1));
      props[key] = value;
      continue;
    }
    // Legacy format (pre-stream-serializer): `key: value`. Values were
    // not escaped — taken verbatim. The required trailing space after `:`
    // disambiguates from `:`s inside ISO timestamps and JSON values
    // (which never have a trailing space).
    const colonIdx = line.indexOf(": ");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx);
      const value = line.slice(colonIdx + 2);
      props[key] = value;
    }
  }
  return props;
}

const CONTENT_LINE_ESC_RE = /^---/gm;
const CONTENT_LINE_UNESC_RE = /^\\---/gm;

export function escapeContent(content: string): string {
  return content.replace(CONTENT_LINE_ESC_RE, "\\---");
}

export function unescapeContent(content: string): string {
  return content.replace(CONTENT_LINE_UNESC_RE, "---");
}

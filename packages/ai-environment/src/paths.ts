// Path rules: every path the gate sees is normalised first, and authorization runs on that.
// As in POSIX, "/.." is "/".
import { codedError } from "@statewalker/ai-access";

export function normalise(p: unknown): string {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0"))
    throw codedError("EINVAL", `invalid path '${String(p)}'`);
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

export const parentOf = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
};

export const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

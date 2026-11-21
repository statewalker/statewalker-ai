// Ignore rules (statewalker/statewalker-root#80): patterns in gitignore syntax naming files that
// agents and tools never see. A workspace's defaults come from the deployment's configuration and
// each project's optional `.system/ignore` adds to them; paths are relative to the project. They
// only narrow on top of permissions: a negation never brings back a file under an ignored folder,
// as in git.
import ignore from "ignore";
import type { IgnoreMatcher } from "./gated-files.js";

/** The project's file of ignore rules, in its system folder. */
export const IGNORE_FILE = "ignore";

/** A matcher of the patterns in these texts (gitignore syntax, one pattern per line). */
export function ignoreRules(texts: readonly (string | undefined)[]): IgnoreMatcher {
  const ig = ignore().add(texts.filter((t): t is string => !!t).join("\n"));
  const test = (rel: string) => {
    try {
      return ig.ignores(rel);
    } catch {
      // A segment `ignore` refuses (such as one that is not a relative path) hides nothing more.
      return false;
    }
  };
  return {
    ignores(segments) {
      // Each folder on the way, then the entry itself as a file or as a folder (a pattern that
      // names folders only hides a file of that name too: rules only narrow).
      for (let i = 1; i < segments.length; i++)
        if (test(`${segments.slice(0, i).join("/")}/`)) return true;
      const rel = segments.join("/");
      return test(rel) || test(`${rel}/`);
    },
  };
}

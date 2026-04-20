export interface SkillInfo {
  name: string;
  description: string;
  /** Opaque location hint (URL, path, etc.) — informational only. */
  location?: string;
  /** Full markdown content of the skill. */
  content: string;
}

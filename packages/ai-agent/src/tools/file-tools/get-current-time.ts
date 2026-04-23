import { tool } from "ai";
import { z } from "zod";

export const getCurrentTimeTool = tool({
  description: "Returns the current date and time",
  inputSchema: z.object({
    timezone: z.string().optional().describe("IANA timezone, e.g. 'America/New_York'"),
  }),
  outputSchema: z.object({
    time: z.string().describe("Formatted date and time string in the requested timezone"),
    iso: z.string().describe("ISO 8601 timestamp in UTC"),
  }),
  execute: async ({ timezone }) => {
    const now = new Date();
    const formatted = now.toLocaleString("en-US", {
      timeZone: timezone ?? "UTC",
      dateStyle: "full",
      timeStyle: "long",
    });
    return { time: formatted, iso: now.toISOString() };
  },
});

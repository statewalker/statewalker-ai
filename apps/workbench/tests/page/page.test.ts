// The built workbench in Chromium: the harness starts in the page on CellB, and the terminal's
// commands reach it through the session API. Run by `test:page` after `build` (CI's browser job).
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

let server: Server;
let browser: Browser;
let page: Page;

async function launch(): Promise<Browser> {
  const executablePath = process.env.CONFORMANCE_CHROMIUM || undefined;
  try {
    return await chromium.launch({ executablePath });
  } catch (e) {
    if (executablePath) throw e;
    return chromium.launch({ channel: "chrome" });
  }
}

const screen = () => page.locator(".xterm-rows").innerText();
const prompts = async () => (await screen()).split("›").length;
/** Types a command, waits for the next prompt (the command has ended), then for `until`. */
async function type(line: string, until: string | RegExp) {
  const before = await prompts();
  await page.locator(".xterm-helper-textarea").pressSequentially(line);
  await page.keyboard.press("Enter");
  await expect.poll(prompts, { timeout: 30_000 }).toBeGreaterThan(before);
  await expect.poll(screen, { timeout: 5_000 }).toMatch(until);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const file = join(DIST, normalize(path === "/" ? "/index.html" : path));
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await launch();
  page = await browser.newPage();
  page.on("pageerror", (e) => {
    if (!/dynamically imported module: node:/.test(e.message)) console.error("[page]", e);
  });
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  // Polled by hand: expect.poll belongs to a test.
  for (let i = 0; !/the harness runs in this page/.test(await screen()); i++) {
    if (i > 600) throw new Error(`the workbench did not start:\n${await screen()}`);
    await page.waitForTimeout(100);
  }
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("the workbench page", () => {
  it("starts the harness in the page and signs its user in", async () => {
    await type("whoami", /me \(mode default\), project home/);
  });

  it("writes and reads the user's files in the page's harness", async () => {
    await type('write /home/hello.md "hello from the page"', /wrote \/home\/hello\.md/);
    await type("cat /home/hello.md", /hello from the page/);
  });

  it("keeps the user's own secret in the page, asked for unseen and never shown", async () => {
    const input = page.locator(".xterm-helper-textarea");
    await input.pressSequentially("secret set OWN_KEY model-gateway api.example.com");
    await page.keyboard.press("Enter");
    await expect.poll(screen, { timeout: 30_000 }).toMatch(/value of OWN_KEY:/);
    await type("sk-page-77", /secret OWN_KEY set for model-gateway at api\.example\.com/);
    await type("secret list", /OWN_KEY \{/);
    expect(await screen()).not.toContain("sk-page-77");
  });

  it("runs a local model engine in the page, downloading no weights until the user asks", async () => {
    const m = "SmolLM2-135M-Instruct-q0f16-MLC";
    await type(`local use ${m}`, new RegExp(`download it first: local download ${m}`));
    await type("local", new RegExp(`local/${m} \\(not downloaded`));
  });
});

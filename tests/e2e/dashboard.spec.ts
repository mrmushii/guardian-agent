import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

try { process.loadEnvFile(resolve(process.cwd(), ".env")); } catch { /* env provided */ }
// Testnet owner key, used only against localhost: stands in for a browser wallet extension.
const owner = privateKeyToAccount(process.env.TESTNET_OWNER_PRIVATE_KEY as Hex);

/** Injects an EIP-1193 provider whose personal_sign is answered by the test owner key. */
async function installWallet(page: Page) {
  await page.exposeFunction("__guardianSign", (data: Hex) => owner.signMessage({ message: { raw: data } }));
  await page.addInitScript((address: string) => {
    try { localStorage.setItem("guardian.onboarded", "1"); } catch { /* storage unavailable */ }
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
        if (method === "eth_chainId") return "0x14a34";
        if (method === "personal_sign") return (window as unknown as { __guardianSign: (d: string) => Promise<string> }).__guardianSign((params as string[])[0]!);
        throw new Error(`unsupported ${method}`);
      },
    };
  }, owner.address);
}

async function signIn(page: Page) {
  await installWallet(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with owner wallet" }).click();
  await expect(page.getByRole("region", { name: "Agent authority" })).toBeVisible({ timeout: 30_000 });
}

test("unauthenticated visitors see only the sign-in screen", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in with owner wallet" })).toBeVisible();
  expect((await page.request.get("/api/dashboard")).status()).toBe(401);
});

test("owner signs in and sees live account, authority, and activity", async ({ page }) => {
  await signIn(page);
  // Two-asset mode shows the band gauge; multi-asset mode shows one bar per asset.
  await expect(page.getByRole("img", { name: /^(Allowed band \d+ to \d+ percent|Allocation: )/ }).first()).toBeVisible();
  const authority = page.getByRole("region", { name: "Agent authority" });
  await expect(authority.getByText("Active on-chain")).toBeVisible();
  await expect(authority.getByText(/WETH/).first()).toBeVisible();
  // v2 two-way permission: buy-side cap and the resetting per-window swap count.
  await expect(authority.getByText("Per purchase")).toBeVisible();
  await expect(authority.getByText(/^\d+(\.\d+)? USDC/)).toBeVisible();
  await expect(authority.getByText(/^\d+ of 6/)).toBeVisible();
  await expect(authority.getByText(/per 24 h, resets/)).toBeVisible();
  // Plain-language status and the owner task list lead the page.
  await expect(page.getByRole("region", { name: "Agent status" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Your tasks" })).toBeVisible();
  // History lives in the Activity view of the command center.
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Activity" }).click();
  await page.getByRole("tab", { name: "Account" }).click();
  const identities = page.getByRole("region", { name: "Identities" });
  await expect(identities.getByText(owner.address)).toBeVisible();
  await expect(identities.getByText("0x11Bc46A51a49d1424c6474fb318C904E451654b7")).toBeVisible();
  // Real history from the testnet runs: confirmed rebalances and their evidence links.
  await page.getByRole("tab", { name: "Activity" }).click();
  const activity = page.getByRole("region", { name: "Activity timeline" });
  // Live history: confirmations can be older than the newest 25 events, so look under the Trades filter.
  await activity.getByRole("button", { name: "Trades" }).click();
  await expect(activity.getByText(/Confirmed in block/).first()).toBeVisible();
  await expect(activity.getByRole("link", { name: /^Transaction 0x/ }).first()).toHaveAttribute("href", /sepolia\.basescan\.org\/tx\//);
  await page.getByRole("tab", { name: "Transactions" }).click();
  const ops = page.getByRole("region", { name: "Operations" });
  await expect(ops.getByText("Agent session").first()).toBeVisible();
  await expect(ops.getByText("Master owner").first()).toBeVisible();
  await page.screenshot({ path: "test-results/dashboard-desktop.png", fullPage: true });
});

test("command palette opens with Ctrl+K and navigates", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await page.getByRole("textbox", { name: "Command" }).fill("limits");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Edit limits" })).toBeVisible();
  await expect(page.getByRole("region", { name: "What if" })).toBeVisible();
});

test("dashboard fits a phone screen without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // On a phone: status, then your tasks, then what the agent is doing, then its limits.
  const y = async (name: string) => (await page.getByRole("region", { name }).boundingBox())!.y;
  expect(await y("Agent status")).toBeLessThan(await y("Your tasks"));
  expect(await y("Your tasks")).toBeLessThan(await y("Current progress"));
  expect(await y("Current progress")).toBeLessThan(await y("Agent authority"));
  await expect(page.getByRole("navigation", { name: "Main (mobile)" })).toBeVisible();
  await page.screenshot({ path: "test-results/dashboard-mobile.png", fullPage: true });
});

test("signing in with a non-owner wallet shows no account data", async ({ browser }) => {
  const page = await browser.newPage();
  const stranger = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  await page.exposeFunction("__guardianSign", (data: Hex) => stranger.signMessage({ message: { raw: data } }));
  await page.addInitScript((address: string) => {
    try { localStorage.setItem("guardian.onboarded", "1"); } catch { /* storage unavailable */ }
    (window as unknown as { ethereum: unknown }).ethereum = { request: async ({ method, params }: { method: string; params?: unknown[] }) =>
      method === "personal_sign" ? (window as unknown as { __guardianSign: (d: string) => Promise<string> }).__guardianSign((params as string[])[0]!) : [address] };
  }, stranger.address);
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with owner wallet" }).click();
  await expect(page.getByText("No smart account registered for this wallet")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Agent authority" })).toHaveCount(0);
});

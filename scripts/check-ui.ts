/**
 * Drive the picker and the verified-record button, the way a judge would.
 *
 * Two controls, and both fail in ways a build cannot see: a picker that does not
 * change what the page asks for, and a button that fills a field with an id that
 * belongs to the other chain. Neither throws. One shows the wrong chain's answer,
 * the other shows "no record".
 *
 *   pnpm tsx scripts/check-ui.ts
 */

import {chromium} from "playwright";

const SITE = process.env.HOROS_SITE ?? "https://horos.kiter0211.workers.dev";

const MAINNET_ID = "0xe1d1cd45a2d4fa29a9568d2bf5435b25153a55a70d200456c68199a0abbee07b";
const TESTNET_ID = "0xd089b3475da02e89995747482c11f095f6b8c38cf7adb22556d9451f4fee5d5d";

type Problem = string;
const problems: Problem[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "\u2713" : "\u2717"} ${what}`);
  if (!ok) problems.push(what);
};

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});

  const asked: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/") && u.pathname !== "/api/networks") {
      asked.push(`${u.pathname}?${u.searchParams.get("network") ?? "(none)"}`);
    }
  });

  console.log(`\n  ${SITE}\n`);

  // ---- the picker exists and offers both chains ---------------------------
  await page.goto(SITE, {waitUntil: "networkidle"});
  const options = await page.locator("#network option").allTextContents();
  check(options.length === 2, `picker offers both chains (${options.join(", ")})`);

  const custody = await page.locator("[data-custody]").textContent();
  check(Boolean(custody && custody.length > 4), `custody stated beside the picker ("${(custody ?? "").trim()}")`);

  // ---- the verified-record button fills this chain's record ---------------
  await page.click("#verified");
  await page.waitForTimeout(2500);
  const filled = await page.inputValue("#cp");
  check(filled === TESTNET_ID, `button filled the testnet counterparty (${filled.slice(0, 14)}…)`);
  const invoice = await page.inputValue("#text");
  check(/DISREGARD PREVIOUS REMITTANCE/.test(invoice), "it filled the redirected invoice, not a bland one");

  // ---- and Decide refuses, against a real record --------------------------
  await page.click("#go");
  await page.waitForSelector("#result .verdict", {timeout: 30_000});
  const verdict = (await page.locator("#result .verdict").first().textContent())?.trim();
  check(verdict === "HOLD", `it refuses (${verdict})`);
  const reasons = await page.locator("#result [data-block=\"reasons\"] li.block").count();
  check(reasons >= 5, `${reasons} blocking reasons shown`);

  // ---- switching chain changes what the API is asked ---------------------
  asked.length = 0;
  await page.selectOption("#network", "arc-mainnet");
  await page.waitForTimeout(1200);
  await page.click("#verified");
  await page.waitForTimeout(2500);
  const mainnetFilled = await page.inputValue("#cp");
  check(mainnetFilled === MAINNET_ID, `switching chain changed which record is verified (${mainnetFilled.slice(0, 14)}…)`);
  check(
    asked.length > 0 && asked.every((a) => a.endsWith("arc-mainnet")),
    `every request after the switch named mainnet (${asked.length} requests)`,
  );

  // ---- the mainnet record renders its own chain --------------------------
  await page.click("#go");
  await page.waitForSelector("#result .verdict", {timeout: 30_000});
  const chainLine = (await page.locator("#result .meta").first().textContent())?.trim() ?? "";
  check(chainLine.startsWith("Arc "), `the card names the chain it read (${chainLine.slice(0, 30)}…)`);

  // ---- and the record page follows the picker ---------------------------
  await page.goto(`${SITE}/c/${MAINNET_ID}`, {waitUntil: "networkidle"});
  await page.waitForSelector(".lineage li", {timeout: 20_000});
  const accounts = await page.locator(".lineage li").count();
  check(accounts === 2, `the mainnet record shows both accounts (${accounts})`);

  await browser.close();

  console.log("");
  if (problems.length > 0) {
    console.error(`  ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`    - ${p}`);
    console.error("");
    process.exit(1);
  }
  console.log("  ui ok — picker switches chains, button loads the verified record\n");
}

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

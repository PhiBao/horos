/**
 * Drive the deployed site and save what a person would see.
 *
 * The video needs the real pages, not a mock-up of them, and this is also the only
 * way anyone has actually looked at these pages - there is no desktop browser in
 * this environment, so a broken layout would otherwise ship unobserved.
 *
 *   pnpm tsx scripts/capture.ts
 *
 * Writes PNGs to .capture/ (gitignored). Refuses to run against anything but the
 * deployed site, so a capture can never be mistaken for a local render.
 */

import {mkdirSync} from "node:fs";
import {resolve} from "node:path";

import {chromium} from "playwright";

const SITE = process.env.HOROS_SITE ?? "https://horos.kiter0211.workers.dev";
const OUT = resolve(".capture");

/** The counterparty the demo seeded, with the ceremony behind it. */
const CP = "0xeb69a61e27f3e8a720fc909cd60db114fc21565da2f8da958216344076716f62";

async function main(): Promise<void> {
  if (!/^https:\/\//.test(SITE)) {
    throw new Error(`refusing to capture ${SITE}: this is for the deployed site, so a screenshot cannot be mistaken for a local render`);
  }
  mkdirSync(OUT, {recursive: true});

  const browser = await chromium.launch();
  // 16:10 at 2x, so the video has headroom to pan and still reads on a phone.
  const page = await browser.newPage({viewport: {width: 1440, height: 900}, deviceScaleFactor: 2});

  const shot = async (name: string, opts: {full?: boolean; wait?: number} = {}) => {
    await page.waitForTimeout(opts.wait ?? 700);
    const file = resolve(OUT, `${name}.png`);
    await page.screenshot({path: file, fullPage: opts.full ?? false});
    console.log(`  ${name}.png`);
  };

  console.log(`capturing ${SITE}`);

  // ---- 1. the decision card, empty -------------------------------------------
  await page.goto(`${SITE}/?cp=${CP}`, {waitUntil: "networkidle"});
  await shot("01-empty", {wait: 1500});

  // ---- 2. load the record, so the page knows what is on file ------------------
  await page.click("#find");
  await shot("02-record-loaded", {wait: 1800});

  // ---- 3. the routine invoice releases ---------------------------------------
  await page.click('[data-sample="ordinary"]');
  await page.click("#go");
  await page.waitForSelector("#result .verdict", {timeout: 30_000});
  await shot("03-released", {wait: 1500});

  // ---- 4. the redirected one refuses, and says why ---------------------------
  await page.click('[data-sample="attack"]');
  await page.click("#go");
  await page.waitForFunction(
    () => document.querySelector("#result .verdict")?.textContent?.includes("HOLD"),
    {timeout: 30_000},
  );
  await shot("04-refused", {wait: 1500});
  // And the working underneath it: the probabilities and the blocking reasons.
  await shot("05-refused-detail", {full: true, wait: 800});

  // ---- 5. the public record -------------------------------------------------
  await page.goto(`${SITE}/c/${CP}`, {waitUntil: "networkidle"});
  await page.waitForSelector(".lineage li", {timeout: 20_000});
  await shot("06-record", {wait: 1200});
  await shot("07-record-full", {full: true, wait: 800});

  // ---- 6. the pilot page ----------------------------------------------------
  await page.goto(`${SITE}/start`, {waitUntil: "networkidle"});
  await shot("08-start", {wait: 900});

  await browser.close();
  console.log(`\n  ${OUT}\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

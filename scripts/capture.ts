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
const CP = "0xf85f374f0e39541527bc02e3a90ff684a86c9a099d8db994e09d94be651da9b6";

async function main(): Promise<void> {
  if (!/^https:\/\//.test(SITE)) {
    throw new Error(`refusing to capture ${SITE}: this is for the deployed site, so a screenshot cannot be mistaken for a local render`);
  }
  mkdirSync(OUT, {recursive: true});

  const browser = await chromium.launch();
  // 16:10 at 2x, so the video has headroom to pan and still reads on a phone.
  const page = await browser.newPage({viewport: {width: 1440, height: 900}, deviceScaleFactor: 3});

  const shot = async (name: string, opts: {wait?: number} = {}) => {
    await page.waitForTimeout(opts.wait ?? 600);
    await page.screenshot({path: resolve(OUT, `${name}.png`)});
    console.log(`  ${name}.png`);
  };

  /**
   * Frame one part of the page.
   *
   * Viewport screenshots anchored on a block, not full-page ones. A full-page grab
   * of this card is around 1.5 screens tall; scaled into a 1080p video frame the
   * body text lands near 13px and is unreadable, which is how the first cut of the
   * video turned the most important screen in the product into a grey smudge. The
   * viewport shot is already the right shape, so nothing has to be shrunk.
   */
  const frame = async (name: string, selector: string, nudge = 0) => {
    await page.evaluate(
      ([sel, n]) => {
        const el = document.querySelector(sel as string);
        if (el) window.scrollTo({top: el.getBoundingClientRect().top + window.scrollY + (n as number) - 24});
      },
      [selector, nudge] as const,
    );
    await shot(name, {wait: 800});
  };

  /**
   * One block, cropped to itself.
   *
   * The counterpart of `frame`. A viewport shot of the decision card contains the
   * block plus two columns of unrelated card around it, so scaling that up for the
   * video makes the block small again - which is exactly what happened to the
   * judgment panel. An element shot has no unrelated pixels to scale past.
   */
  const element = async (name: string, selector: string) => {
    // Wider than the video frame needs, on purpose. The decision card is a two-column
    // grid, so each block is about a third of the viewport at normal width; scaled up
    // to fill a 1080p frame that is a 4x blow-up and reads as a smudge. Widening the
    // page first means the crop comes from more real pixels than it needs.
    // The page caps its content column at 980px, so simply widening the viewport
    // changes nothing - the grid stays narrow and the crop stays small. Loosening
    // that cap for the duration of the capture is what actually buys the pixels.
    await page.setViewportSize({width: 1760, height: 1200});
    await page.addStyleTag({content: ".wrap { max-width: 1680px !important; }"});
    await page.waitForTimeout(300);
    const el = page.locator(selector).first();
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await el.screenshot({path: resolve(OUT, `${name}.png`)});
    const box = await el.boundingBox();
    console.log(`  ${name}.png  ${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : ""}`);
    await page.setViewportSize({width: 1440, height: 900});
  };

  console.log(`capturing ${SITE}`);

  // ---- the card, before anything is asked of it -----------------------------
  await page.goto(`${SITE}/?cp=${CP}`, {waitUntil: "networkidle"});
  await shot("01-empty", {wait: 1500});

  // ---- load the record ------------------------------------------------------
  await page.click("#find");
  await shot("02-record-loaded", {wait: 1800});

  // ---- the routine invoice releases ----------------------------------------
  await page.click('[data-sample="ordinary"]');
  await page.click("#go");
  await page.waitForSelector("#result .verdict", {timeout: 30_000});
  await frame("03-released", '[data-block="verdict"]');
  await element("el-released-reasons", '[data-block="reasons"]');

  // ---- the redirected one refuses ------------------------------------------
  await page.click('[data-sample="attack"]');
  await page.click("#go");
  await page.waitForFunction(
    () => document.querySelector("#result .verdict")?.textContent?.includes("HOLD"),
    {timeout: 30_000},
  );
  await frame("04-refused", '[data-block="verdict"]');
  await element("el-refusal-reasons", '[data-block="reasons"]');
  await element("el-refusal-judgment", '[data-block="judgment"]');
  await element("el-refusal-reading", '[data-block="reading"]');
  await element("el-refusal-contract", '[data-block="contract"]');
  await element("el-refusal-counterparty", '[data-block="counterparty"]');

  // ---- the public record ----------------------------------------------------
  await page.goto(`${SITE}/c/${CP}`, {waitUntil: "networkidle"});
  await page.waitForSelector("[data-block=\"lineage\"] li", {timeout: 20_000});
  await element("el-record-facts", '[data-block="facts"]');
  await frame("07-record-lineage", '[data-block="succession"]');
  await element("el-record-lineage", '[data-block="lineage"]');

  // ---- the pilot page ------------------------------------------------------
  await page.goto(`${SITE}/start`, {waitUntil: "networkidle"});
  await shot("08-start", {wait: 900});

  await browser.close();
  console.log(`\n  ${OUT}\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

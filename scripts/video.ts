/**
 * Build the demo video.
 *
 * Two things this is not. It is not a screen recording - there is no desktop here -
 * and it is not a mock-up. Every frame is either a screenshot of the deployed site
 * driven by a real browser (scripts/capture.ts) or the actual output of a script
 * reading the chain. Nothing is illustrated.
 *
 * Silent by design, with captions, so it works with the sound off and does not
 * depend on a voice that can be re-recorded badly at 2am.
 *
 *   pnpm capture     # screenshots of the deployed site, first
 *   pnpm video
 *
 * Writes .video/horos-demo.mp4.
 */

import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

import {chromium} from "playwright";

const OUT = resolve(".video");
const CAPTURE = resolve(".capture");
const W = 1920;
const H = 1080;
const FPS = 30;
const FADE = 0.45;

const ESCAPES: Record<string, string> = {"&": "&amp;", "<": "&lt;", ">": "&gt;"};
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ESCAPES[c] ?? c);

/** Strip ANSI colour codes from a transcript, keeping the text. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ---------------------------------------------------------------------------
// Scene rendering
// ---------------------------------------------------------------------------

const SHELL = (title: string, body: string, extra = "") => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: ${W}px; height: ${H}px; overflow: hidden;
    background: #0b0d12; color: #e6e9ef;
    font: 21px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column;
    padding: 46px 64px 40px;
  }
  .eyebrow { color: #6b7387; font-size: 16px; letter-spacing: .16em; text-transform: uppercase; margin-bottom: 16px; }
  h1 { font-size: 62px; line-height: 1.16; letter-spacing: -.015em; margin-bottom: 18px; font-weight: 700; }
  h1.small { font-size: 46px; }
  .sub { color: #99a1b3; font-size: 24px; line-height: 1.55; max-width: 82ch; }
  .sub + .sub { margin-top: 12px; }
  .body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; justify-content: center; }
  ${extra}
</style></head><body>${body}</body></html>`;

/** A terminal, styled to match the demo output rather than to look retro. */
const terminal = (lines: string[], caption: string) => SHELL(
  caption,
  `<div class="eyebrow">${esc(caption)}</div>
   <div class="term body"><pre>${esc(lines.join("\n"))}</pre></div>`,
  `
  /* Hug the text and centre the box, rather than stretching to fill the frame and
     centring the text inside it. The second version puts a short transcript in the
     middle of a very tall empty rectangle, which reads as a rendering fault. */
  .term {
    flex: 0 0 auto; align-self: center; width: 100%;
    background: #12151c; border: 1px solid #242a36; border-radius: 12px;
    padding: 30px 38px; overflow: hidden;
  }
  .term pre {
    font-family: "DejaVu Sans Mono", ui-monospace, monospace;
    font-size: 20px; line-height: 1.5; white-space: pre-wrap; color: #d6dae3;
  }
  `,
);

/** A screenshot, framed and cropped to the part that matters. */
const shot = (file: string, caption: string, crop: string | null) => SHELL(
  caption,
  `<div class="eyebrow">${esc(caption)}</div>
   <div class="shot body"><img src="file://${resolve(CAPTURE, file)}"></div>`,
  `
  .shot { align-items: center; }
  .shot img {
    max-width: 100%; max-height: 100%; object-fit: contain;
    border: 1px solid #242a36; border-radius: 10px;
    ${crop ? `object-position: ${crop};` : ""}
  }
  `,
);

/**
 * Cut a long transcript into pages that fit.
 *
 * Rendering the whole thing at a readable size overflows the frame, and shrinking
 * it to fit makes it unreadable on a laptop. Paging is honest about the fact that
 * the output is longer than the screen.
 */
function paginate(lines: string[], perPage: number): string[][] {
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  return pages;
}

/** Keep the blank lines and the wrapping the way the terminal printed them. */
function wrap(lines: string[], width: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    // Indentation is load-bearing in this output, so continuation lines keep it.
    const indent = (line.match(/^\s*/)?.[0] ?? "") + "    ";
    let rest = line;
    let first = true;
    while (rest.length > width) {
      out.push((first ? "" : indent) + rest.slice(0, width));
      rest = rest.slice(width);
      first = false;
    }
    out.push((first ? "" : indent) + rest);
  }
  return out;
}

/**
 * Split a demo transcript on its numbered steps.
 *
 * The demo prints "01." through "08." as it goes, so the steps are already marked
 * and there is no reason to re-derive them from a regex over prose. Selecting real
 * sections rather than retyping them means the video cannot show output the script
 * did not produce.
 */
function sections(text: string): {title: string; lines: string[]}[] {
  const out: {title: string; lines: string[]}[] = [];
  for (const line of plain(text).split("\n")) {
    const m = line.match(/^\s*(\d\d)\.\s+(.*)$/);
    if (m) out.push({title: `${m[1]}. ${m[2]}`, lines: [line]});
    else if (out.length) out[out.length - 1].lines.push(line);
    else if (line.trim()) {
      if (out.length === 0) out.push({title: "", lines: []});
      out[out.length - 1].lines.push(line);
    }
  }
  return out.filter((s) => s.title || s.lines.some((l) => l.trim()));
}

/** Drop the polling chatter, which is real but says the same thing nine times. */
function withoutPolling(lines: string[]): string[] {
  return lines.filter((l) => !/^\s*Circle:\s*(QUEUED|COMPLETE|CLEARED)\s*$/.test(l));
}

type Scene = {name: string; caption: string; seconds: number; html: string};

function buildScenes(): Scene[] {
  const scenes: Scene[] = [];
  const add = (name: string, caption: string, seconds: number, html: string) =>
    scenes.push({name, caption, seconds, html});

  // ---- 1. title ------------------------------------------------------------
  add("01-title", "", 6, SHELL("", `
    <div class="body">
      <div class="eyebrow">Tameion Agents Hackathon · Canteen × Circle × Arc</div>
      <h1>Horos</h1>
      <p class="sub">An agent that pays your invoices, and will not send USDC to an
      address it cannot prove is the counterparty it already paid.</p>
    </div>`));

  // ---- 2. the problem ------------------------------------------------------
  add("02-problem", "", 9, SHELL("", `
    <div class="body">
      <h1 class="small">The attack is one sentence long.</h1>
      <p class="sub">"Our bank details have changed." Business email compromise cost
      <strong>$3.04 billion</strong> in 2025 across 24,768 incidents, at an average of
      over $122,000 each.</p>
      <p class="sub">The standard control is to phone the vendor and confirm. As of 2026
      that control is itself attacked — deepfake voice and video impersonation of
      vendors was measured for the first time.</p>
      <p class="sub">Every channel a business uses to learn a new address can now be
      synthesised. So Horos does not try to tell a real voice from a fake one.</p>
    </div>`));

  // ---- 3. the claim --------------------------------------------------------
  add("03-claim", "", 10, SHELL("", `
    <div class="body">
      <h1 class="small">It refuses by not being able to comply.</h1>
      <div class="code">CustodyVault.pay(bytes32 counterpartyId, uint256 amount, bytes32 ref)</div>
      <p class="sub">There is no <code>to</code> parameter. The caller names <em>who</em>
      to pay, never <em>where</em>. The destination is read from the registry.</p>
      <p class="sub">So a compromised agent, a bad prompt, or a bug in the website cannot
      express "pay this new address". It is not a check that failed. It is a sentence
      the contract cannot be given.</p>
    </div>`,
    `.code {
       font-family: "DejaVu Sans Mono", ui-monospace, monospace;
       font-size: 29px; color: #e6e9ef; background: #12151c;
       border: 1px solid #242a36; border-left: 4px solid #2ea043;
       border-radius: 8px; padding: 22px 26px; margin: 8px 0 26px;
       overflow-wrap: anywhere;
     }
     code { font-family: "DejaVu Sans Mono", ui-monospace, monospace; font-size: 20px; color: #e6e9ef; }`));

  // ---- 4-7. the deployed site ---------------------------------------------
  /**
   * A cropped block, sized to fill the frame.
   *
   * These are element captures, not viewport ones, so there is no card around them
   * to scale past. The width goes to the frame and the overflow crops, which is the
   * right trade: the top of a panel is what a viewer reads.
   */
  const blocks: [string, string, number, string][] = [
    ["04-refused", "The deployed site · the redirected invoice", 12,
     "Same counterparty, same vendor name, one changed account. It refuses."],
    ["el-refusal-reasons", "The deployed site · every reason, named", 15,
     "Six blocking reasons, each naming its own signal. The first is the text in the document addressed to whoever is reading it — a supplier invoice has no reason to say that."],
    ["el-record-lineage", "The deployed site · the public record", 13,
     "A supplier genuinely changed accounts. Two signatures: the account that was last paid, and the business. Never the recipient."],
  ];
  for (const [file, caption, secs, sub] of blocks) {
    if (!existsSync(resolve(CAPTURE, `${file}.png`))) {
      console.warn(`  missing capture ${file}.png — run pnpm capture first`);
      continue;
    }
    add(`site-${file}`, caption, secs, SHELL(caption, `
      <div class="eyebrow">${esc(caption)}</div>
      <div class="shot body"><img src="file://${resolve(CAPTURE, `${file}.png`)}"></div>
      <p class="cap">${esc(sub)}</p>`,
      `
      /* Anchor to the top. Centring the image crops both ends, which silently ate
         the first - and most interesting - reason on the reasons panel while the
         caption went on describing it. */
      .shot { overflow: hidden; align-items: flex-start; justify-content: flex-start; }
      .shot img { width: 100%; height: auto; max-height: none; max-width: none;
                  border: 1px solid #242a36; border-radius: 10px; }
      .cap { color: #99a1b3; font-size: 22px; line-height: 1.45; margin-top: 22px; max-width: 96ch; }
      `));
  }

  // ---- the live run, keyless, in the transcript the script printed ---------
  //
  // These are the strongest frames in the video and the only ones that show money
  // moving. Same rule as everything else: the text is the script's own stdout,
  // sectioned, not retyped - so the video cannot show a run that did not happen.
  const demoPath = resolve(OUT, "demo.txt");
  if (existsSync(demoPath)) {
    const parts = sections(readFileSync(demoPath, "utf8"));
    const pick = (...n: number[]) => parts.filter((p) => n.some((i) => p.title.startsWith(String(i).padStart(2, "0") + ".")));
    const show = (sel: {title: string; lines: string[]}[], perPage: number) =>
      paginate(
        wrap(withoutPolling(sel.flatMap((p) => p.lines)).filter((l) => l.trim() !== ""), 118),
        perPage,
      );

    // Section boundaries are story boundaries: never merge across non-adjacent
    // sections. An earlier cut concatenated 01 with 04 and silently dropped 02
    // and 03 — the funding and the registration, the one step the whole ceremony
    // depends on — from the video.
    const runs: [string, string, number, {title: string; lines: string[]}[]][] = [
      ["demo-keyless", "The live run · no key in this process", 8, pick(1)],
      ["demo-register", "The live run · the business is named, once", 12, pick(2, 3)],
      ["demo-refusal", "The live run · the policy refuses", 18, pick(5)],
      ["demo-ceremony", "The live run · the ceremony, signed by Circle", 16, pick(6)],
      ["demo-paid", "The live run · and now it pays", 14, pick(7, 8)],
    ];

    for (const [name, caption, secs, sel] of runs) {
      const pages = show(sel, 24);
      if (pages.length === 0) {
        console.warn(`  no transcript for ${name} — run the demo and save .video/demo.txt`);
        continue;
      }
      pages.forEach((page, i) => {
        add(
          `${name}${pages.length > 1 ? `-${i + 1}` : ""}`,
          `${caption}${pages.length > 1 ? ` (${i + 1}/${pages.length})` : ""}`,
          pages.length > 1 ? Math.round(secs / pages.length) : secs,
          terminal(page, caption),
        );
      });
    }
  }

  // ---- the chain, read with no key -----------------------------------
  const transcriptPath = resolve(OUT, "verify.txt");
  if (existsSync(transcriptPath)) {
    const lines = wrap(plain(readFileSync(transcriptPath, "utf8")).split("\n"), 96);
    const pages = paginate(lines, 26);
    pages.forEach((page, i) => {
      add(
        `verify-${i + 1}`,
        `The chain, read with no key and no API${pages.length > 1 ? ` · ${i + 1}/${pages.length}` : ""}`,
        15,
        terminal(page, `pnpm verify — the deployment's whole story, from the chain`),
      );
    });
  }

  // ---- 10. closing ---------------------------------------------------------
  add("99-end", "", 8, SHELL("", `
    <div class="body">
      <h1 class="small">The refusal is the product.</h1>
      <p class="sub">Horos is live on Arc testnet, and the record above was made by a
      real ceremony — every transaction on the explorer.</p>
      <p class="sub link">horos.kiter0211.workers.dev</p>
      <p class="sub link">github.com/PhiBao/horos</p>
      <p class="sub small">The site holds no key, imports the same policy the tests run
      against, and its ABI contains no write function. MIT.</p>
    </div>`,
    `.link { font-family: "DejaVu Sans Mono", ui-monospace, monospace; color: #6cb6ff; font-size: 22px; margin-top: 6px; }
     .sub.small { font-size: 17px; color: #6b7387; margin-top: 24px; }`));

  return scenes;
}

// ---------------------------------------------------------------------------
// Rendering and encoding
// ---------------------------------------------------------------------------

async function renderScenes(scenes: Scene[]): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: W, height: H}, deviceScaleFactor: 1});

  for (const scene of scenes) {
    const html = resolve(OUT, `${scene.name}.html`);
    writeFileSync(html, scene.html);
    await page.goto(`file://${html}`, {waitUntil: "load"});
    // Let web fonts and images settle before the frame is taken.
    await page.waitForTimeout(350);
    await page.screenshot({path: resolve(OUT, `${scene.name}.png`)});
    console.log(`  rendered ${scene.name}`);
  }
  await browser.close();
}

function encode(scenes: Scene[]): void {
  const clips: string[] = [];

  for (const [i, scene] of scenes.entries()) {
    const clip = resolve(OUT, `clip-${String(i).padStart(2, "0")}.mp4`);
    const outAt = Math.max(0, scene.seconds - FADE);
    // Fade to and from the page colour rather than to black, so the joins read as
    // one continuous piece rather than as a slideshow of unrelated cards.
    const vf = [
      `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0b0d12`,
      `fade=t=in:st=0:d=${FADE}:color=0x0b0d12`,
      `fade=t=out:st=${outAt}:d=${FADE}:color=0x0b0d12`,
      "format=yuv420p",
    ].join(",");

    execFileSync(
      "ffmpeg",
      [
        "-y", "-loglevel", "error",
        "-loop", "1", "-t", String(scene.seconds), "-i", resolve(OUT, `${scene.name}.png`),
        "-vf", vf, "-r", String(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "19",
        "-pix_fmt", "yuv420p", clip,
      ],
      {stdio: "inherit"},
    );
    clips.push(clip);
    console.log(`  encoded ${scene.name} (${scene.seconds}s)`);
  }

  const list = resolve(OUT, "concat.txt");
  writeFileSync(list, clips.map((c) => `file '${c}'`).join("\n") + "\n");

  const final = resolve(OUT, "horos-demo.mp4");
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", final],
    {stdio: "inherit"},
  );

  const seconds = scenes.reduce((n, s) => n + s.seconds, 0);
  console.log(
    `\n  ${final}\n  ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s, ` +
      `${scenes.length} scenes, limit ${LIMIT_SECONDS}s\n`,
  );
}

/** The brief: under three minutes. */
const LIMIT_SECONDS = 180;

async function main(): Promise<void> {
  mkdirSync(OUT, {recursive: true});
  const scenes = buildScenes();

  const total = scenes.reduce((n, s) => n + s.seconds, 0);
  console.log(`\n  ${scenes.length} scenes, ${total}s`);
  for (const s of scenes) console.log(`    ${String(s.seconds).padStart(3)}s  ${s.name}`);

  if (total > LIMIT_SECONDS) {
    throw new Error(
      `${total}s is over the ${LIMIT_SECONDS}s the brief allows. Cut a scene or shorten one; ` +
        `do not raise this number, because the limit is not ours to move.`,
    );
  }

  await renderScenes(scenes);
  encode(scenes);
}

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

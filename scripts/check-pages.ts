/**
 * Check the two pages are wired to their scripts.
 *
 * No browser is available in this environment, so a screenshot is not an option -
 * and a screenshot would not catch the failure that actually matters here anyway.
 * The one that breaks a page is a selector that matches nothing: `#status`
 * misspelled as `#stats`, a class renamed in the stylesheet but not in the script.
 * Both render fine. They just silently do nothing, or look wrong in one place and
 * right in another.
 *
 * So this walks the selectors and class names in each script and asserts they exist
 * in the HTML or the stylesheet they belong to. Static, fast, and it fails on the
 * things that are invisible in a curl.
 *
 *   pnpm tsx scripts/check-pages.ts
 */

import {readFileSync, readdirSync} from "node:fs";
import {resolve} from "node:path";

const read = (p: string) => readFileSync(resolve("worker/public", p), "utf8");

type Problem = {page: string; kind: string; what: string};

function idsIn(html: string): Set<string> {
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}

function classesIn(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/\bclass="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) if (c) out.add(c);
  return out;
}

function classesInCss(css: string): Set<string> {
  return new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
}

/**
 * Every `$("...")` call whose argument is not a selector.
 *
 * The local helper is `const $ = (s) => document.querySelector(s)`, which takes a
 * CSS selector. Called with a bare identifier it queries a *tag* of that name and
 * returns null - so `$("cp")` where `#cp` was meant silently does nothing and then
 * throws. That is exactly what happened in applySample, and this check exists
 * because the first version of this file only recognised `$("#id")` and sailed
 * straight past it.
 *
 * A null from querySelector is only caught if something dereferences it, and a
 * sample button that puts nothing in the textarea fails quietly at the next step.
 */
function bareDollarCalls(js: string): string[] {
  const out: string[] = [];
  for (const m of js.matchAll(/\$\(\s*"([^"]*)"\s*\)/g)) {
    const arg = m[1];
    if (arg.startsWith("#") || arg.startsWith(".") || arg.startsWith("[") || arg.includes(" ")) continue;
    out.push(arg);
  }
  return out;
}

/** Selectors the script queries, as `#id` or `.class`. */
function selectorsUsed(js: string): {ids: Set<string>; classes: Set<string>} {
  const ids = new Set<string>();
  const classes = new Set<string>();
  // Both `document.querySelector("#x")` and the local `$(...)` helper.
  for (const m of js.matchAll(/[$]\(\s*"#([\w-]+)"/g)) ids.add(m[1]);
  for (const m of js.matchAll(/querySelector(?:All)?\(\s*"\.([\w-]+)/g)) classes.add(m[1]);
  for (const m of js.matchAll(/getElementById\(\s*"([\w-]+)"/g)) ids.add(m[1]);
  return {ids, classes};
}

/**
 * Classes the script puts into markup it builds.
 *
 * Only the ones inside `class="..."` in a template literal, which is where a typo
 * produces a styled-nothing element rather than an error.
 */
/**
 * Ids the script injects, for the same reason: the `/c/` landing page has no id in
 * its HTML and builds the lookup form at runtime.
 */
function idsEmitted(js: string): Set<string> {
  const out = new Set<string>();
  for (const m of js.matchAll(/\bid="([\w-]+)"/g)) out.add(m[1]);
  return out;
}

function classesEmitted(js: string): Set<string> {
  const out = new Set<string>();
  for (const m of js.matchAll(/class="([^"$]*?)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c && !c.includes("{")) out.add(c);
  }
  // Also the conditional `class="${x ? "a" : "b"}"` form, which is common here.
  for (const m of js.matchAll(/class="\$?\{[^}]*?((?:"[\w -]+"\s*:?\s*)+)\}"/g)) {
    for (const q of m[1].matchAll(/"([\w -]+)"/g)) {
      for (const c of q[1].split(/\s+/)) if (c) out.add(c);
    }
  }
  return out;
}

/**
 * The script a page actually loads, taken from its own markup.
 *
 * The first version of this file guessed that index.html loaded index.js, which
 * does not exist - so it read nothing, hit an `if (!js) continue`, and skipped the
 * decision card entirely. It reported "pages OK" while never looking at the most
 * important page on the site, which is the same shape of failure as the bugs this
 * whole month has been about: no error, no output, and a passing check.
 *
 * Reading the src from the HTML cannot drift from what the browser loads.
 */
function scriptOf(html: string): string | null {
  const m = html.match(/<script[^>]*\bsrc="([^"]+)"/);
  return m ? m[1].replace(/^\//, "") : null;
}

function main(): void {
  const css = read("style.css");
  const cssClasses = classesInCss(css);
  const problems: Problem[] = [];

  // Discovered rather than listed, so a page added later cannot quietly escape the
  // check. Every .html in the assets directory with a script tag next to it of the
  // same name gets audited; a page with no script has nothing to wire up.
  const pages = readdirSync(resolve("worker/public"))
    .filter((f) => f.endsWith(".html"))
    .map((f) => {
      const html = read(f);
      const src = scriptOf(html);
      let js = "";
      if (src) {
        try {
          js = read(src);
        } catch {
          throw new Error(`${f} loads ${src}, which is not in worker/public. The page would 404 its own script in production.`);
        }
      }
      return {page: f.replace(/\.html$/, ""), html, js, src};
    });

  // A page with no script has nothing to wire up, but a run that checked no scripts
  // at all must not report success. That is how this file passed while ignoring
  // index.html.
  const withScript = pages.filter((p) => p.src);
  if (withScript.length === 0) {
    console.error("no page loads a script - this check examined nothing, which is not a pass");
    process.exit(1);
  }

  for (const {page, html, js} of withScript) {
    const ids = idsIn(html);
    const htmlClasses = classesIn(html);
    const {ids: usedIds, classes: usedClasses} = selectorsUsed(js);

    for (const arg of bareDollarCalls(js)) {
      problems.push({
        page,
        kind: "selector",
        what: `$("${arg}") passes a bare name to querySelector, which looks for a <${arg}> tag. Did you mean #${arg}?`,
      });
    }

    const injectedIds = idsEmitted(js);
    for (const id of usedIds) {
      if (!ids.has(id) && !injectedIds.has(id)) {
        problems.push({page, kind: "selector", what: `#${id} is queried but is in neither the HTML nor the markup the script builds`});
      }
    }
    for (const c of usedClasses) {
      if (!htmlClasses.has(c) && !classesEmitted(js).has(c)) {
        problems.push({page, kind: "selector", what: `.${c} is queried but appears in neither the HTML nor the markup the script builds`});
      }
    }

    // Every class the page renders should be styled, and every class the script
    // emits should be too. An unstyled one is not an error, but on a page whose
    // whole job is to make a verdict readable, an unstyled highlight is a bug.
    const emitted = classesEmitted(js);
    for (const c of emitted) {
      if (!cssClasses.has(c)) problems.push({page, kind: "style", what: `.${c} is emitted by ${page}.js but has no rule in style.css`});
    }
    for (const c of [...htmlClasses, ...emitted]) {
      if (!cssClasses.has(c) && !["wrap", "mono", "hint"].includes(c)) {
        problems.push({page, kind: "style", what: `.${c} appears on ${page} but has no rule in style.css`});
      }
    }
  }

  // Scripts are loaded as modules and must be, since they use import-less ESM and
  // strict mode; a missing type="module" would silently work but change scoping.
  for (const {page, html} of pages) {
    if (!/<script/.test(html)) continue;
    if (!/<script[^>]+type="module"/.test(html)) {
      problems.push({page, kind: "wiring", what: "no module script tag"});
    }
    if (!/<\/html>\s*$/.test(html.trim())) {
      problems.push({page, kind: "wiring", what: "document does not end with </html>"});
    }
  }

  if (problems.length === 0) {
    console.log(
      `pages OK — ${withScript.length} of ${pages.length} pages load a script, ` +
        `every selector resolves, every emitted class is styled`,
    );
    return;
  }

  console.error(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}:\n`);
  for (const p of problems) console.error(`  [${p.page}/${p.kind}] ${p.what}`);
  console.error("");
  process.exit(1);
}

main();

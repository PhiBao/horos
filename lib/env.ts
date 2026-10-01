/**
 * Configuration loading, in one place.
 *
 * Was three copies of the same forty lines, in demo.ts, demo-circle.ts and
 * check-circle.ts, and the duplication caused a real bug rather than merely
 * offending taste: I unset HOROS_VAULT_OWNER to deploy a vault owned by the local
 * deployer, and the script helpfully reloaded it from .env. The `unset` looked like
 * it had worked, and the deployment came out owned by the agent wallet anyway.
 *
 * Precedence, highest first:
 *
 *   1. the shell environment    - so a one-off run can override anything
 *   2. .env.local               - what deploy.ts writes, gitignored
 *   3. .env                     - the checked-in example with real values filled in
 *
 * An explicit empty string in the shell means "deliberately unset" and wins over
 * the files, which is what makes `HOROS_VAULT_OWNER= pnpm deploy:testnet` do what
 * it looks like it does.
 */

import {readFileSync} from "node:fs";

/**
 * Read .env.local and .env into the environment, without overwriting anything the
 * shell already decided.
 *
 * Parsing is deliberately minimal - KEY=value, one per line, optional quotes, `#`
 * comments. It is not a dotenv implementation and should not grow into one; if this
 * needs escaping rules, the right answer is a real library rather than a fourth
 * version of this function.
 */
export function loadEnv(): void {
  const fromShell = new Set(Object.keys(process.env));
  /**
   * Names an earlier file already provided.
   *
   * Tracked separately from `process.env` rather than inferred from it, because
   * "already set" and "set by a file we just read" are different questions and
   * collapsing them reverses the file order. Snapshotting the shell once and
   * checking only that let .env overwrite .env.local - so a local override was
   * silently ignored, which is exactly the failure this module exists to fix.
   */
  const loaded = new Set<string>();

  for (const file of [".env.local", ".env"]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const [, key, raw] = m;
      // The shell wins, even when its value is empty.
      if (fromShell.has(key) || loaded.has(key)) continue;
      process.env[key] = raw.replace(/^["']|["']$/g, "");
      loaded.add(key);
    }
  }
}

/** A required value, with the error naming the variable rather than the stack line. */
export function required(name: string, why: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set.\n` +
        `  ${why}\n` +
        `  Set it in the shell, or in .env. To set it empty and have that stick, use the shell.\n`,
    );
  }
  return v;
}

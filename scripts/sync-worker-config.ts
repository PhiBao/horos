/**
 * Point the public site at the deployments.
 *
 * `deployments/<network>.json` is written by `scripts/deploy.ts`, and
 * `wrangler.jsonc` is what the Worker reads. Keeping the two in step by hand is the
 * kind of thing that works exactly until it doesn't - the failure mode being a site
 * that cheerfully shows the previous deployment's counterparties and looks like it
 * is lying.
 *
 *   pnpm sync:site
 *
 * Both config files are written from the same map, because there is one Worker
 * codebase and two URLs for it: `wrangler.jsonc` defaults to testnet,
 * `wrangler.mainnet.jsonc` defaults to mainnet, and both can read either chain
 * through the picker in the interface. They differ by exactly one variable, which is
 * why this writes them in one loop rather than being told which one to fix.
 */

import {existsSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

type Deployment = {
  registry: string;
  vault: string;
  chainId: number;
  network: string;
  deployedAt: string;
  /** Set by the demo once it has registered the counterparty. */
  demoCounterpartyId?: string;
};

/** Which config file defaults to which chain. */
const CONFIG_FOR: Record<string, string> = {
  "arc-testnet": "wrangler.jsonc",
  "arc-mainnet": "wrangler.mainnet.jsonc",
};

/** The chain ids this site knows, so a deployment cannot point it at a stranger. */
const KNOWN_CHAINS: Record<string, number> = {
  "arc-testnet": 5042002,
  "arc-mainnet": 5042,
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ID = /^0x[0-9a-fA-F]{64}$/;

type DeploymentValue = {registry: string; vault: string; demoCounterpartyId?: string};

function readDeployments(): {map: Record<string, DeploymentValue>; names: string[]} {
  const dir = resolve("deployments");
  if (!existsSync(dir)) {
    throw new Error("deployments/ does not exist. Deploy first: pnpm deploy:mainnet, or pnpm deploy:testnet.");
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) throw new Error("deployments/ holds no records — deploy first.");

  const map: Record<string, DeploymentValue> = {};
  for (const f of files) {
    const d = JSON.parse(readFileSync(resolve(dir, f), "utf8")) as Deployment;

    const expected = KNOWN_CHAINS[d.network];
    if (expected === undefined) {
      throw new Error(
        `deployments/${f} says network "${d.network}", which this site does not know. ` +
          `Known: ${Object.keys(KNOWN_CHAINS).join(", ")}.`,
      );
    }
    if (d.chainId !== expected) {
      throw new Error(
        `deployments/${f} says ${d.network} but chainId ${d.chainId}; ${d.network} is ${expected}. ` +
          `Refusing to point the site at a contradiction.`,
      );
    }
    if (!ADDRESS.test(d.registry) || !ADDRESS.test(d.vault)) {
      throw new Error(`deployments/${f} does not hold two addresses.`);
    }
    if (d.demoCounterpartyId !== undefined && !ID.test(d.demoCounterpartyId)) {
      throw new Error(`deployments/${f}.demoCounterpartyId is not a counterparty id.`);
    }

    map[d.network] = {
      registry: d.registry,
      vault: d.vault,
      ...(d.demoCounterpartyId ? {demoCounterpartyId: d.demoCounterpartyId} : {}),
    };
  }
  return {map, names: Object.keys(map)};
}

/**
 * Replace one variable's whole line.
 *
 * Not a value-level regex. The deployment map is a JSON *string* full of escaped
 * quotes, and `[^"]*` stops at the first one — which is how an earlier version of
 * this produced a hybrid of the old value and the new one, a config that only failed
 * when the platform parsed it. Matching to the end of the line cannot leave a tail
 * behind, because there is nowhere for a tail to hide.
 */
function setLine(source: string, key: string, value: string, last: boolean): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = new RegExp(`^[ \\t]*"${escapedKey}":\\s*.*$`, "m");
  if (!line.test(source)) throw new Error(`no "${key}" line in this config to write`);
  return source.replace(line, () => `    "${key}": "${value}"${last ? "" : ","}`);
}

/**
 * Strip full-line comments and parse.
 *
 * The check the platform will effectively run. A trailing comma is not written, so
 * a plain JSON parse is a fair test of the whole file — and it validates the inner
 * deployment map at the same time, because that is a string field.
 */
function assertParses(path: string, text: string, expectedNetworks: number): Record<string, DeploymentValue> {
  const stripped = text.replace(/^\s*\/\/.*$/gm, "");
  let config: {vars?: {HOROS_DEPLOYMENTS?: string}};
  try {
    config = JSON.parse(stripped) as {vars?: {HOROS_DEPLOYMENTS?: string}};
  } catch (e) {
    throw new Error(`${path} would not parse after writing: ${(e as Error).message}`);
  }
  const map = config.vars?.HOROS_DEPLOYMENTS;
  if (typeof map !== "string") throw new Error(`${path} has no HOROS_DEPLOYMENTS after writing`);

  let parsed: Record<string, DeploymentValue>;
  try {
    parsed = JSON.parse(map) as Record<string, DeploymentValue>;
  } catch (e) {
    throw new Error(`${path}: HOROS_DEPLOYMENTS is not valid JSON after writing: ${(e as Error).message}`);
  }
  if (Object.keys(parsed).length !== expectedNetworks) {
    throw new Error(
      `${path}: wrote ${Object.keys(parsed).length} deployments, expected ${expectedNetworks}. ` +
        `A stale entry is still in the value.`,
    );
  }
  return parsed;
}

function main(): void {
  const {map, names} = readDeployments();
  console.log(`  deployments on disk: ${names.join(", ")}`);

  // A JSON string inside a JSON string. `JSON.stringify` does the escaping, so the
  // script never hand-writes a backslash.
  const encoded = JSON.stringify(JSON.stringify(map)).slice(1, -1);

  let wrote = 0;
  for (const [network, path] of Object.entries(CONFIG_FOR)) {
    if (!existsSync(resolve(path))) continue;

    const before = readFileSync(resolve(path), "utf8");
    const watch = map[network]?.demoCounterpartyId ?? "";
    // WATCH_IDS is the last key in the vars block, so it carries no comma.
    const after = setLine(setLine(before, "HOROS_DEPLOYMENTS", encoded, false), "WATCH_IDS", watch, true);

    const parsed = assertParses(path, after, names.length);

    if (after === before) {
      console.log(`  ${path}: already current`);
      continue;
    }
    writeFileSync(resolve(path), after);
    wrote++;
    console.log(
      `  ${path}: ${Object.entries(parsed).map(([k, v]) => `${k} ${v.registry}`).join(", ")}`,
    );
  }

  if (wrote === 0) {
    console.log("  nothing to do");
    return;
  }
  console.log(`\n  Deploy the site with:  pnpm site:deploy`);
  if (names.includes("arc-mainnet")) console.log(`                         pnpm site:deploy:mainnet`);
}

main();

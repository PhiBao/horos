/**
 * Point the public site at the current deployment.
 *
 * deployment.json is written by scripts/deploy.ts, and wrangler.jsonc is what the
 * Worker actually reads. Keeping the two in step by hand is the kind of thing that
 * works exactly until it doesn't - the failure mode being a site that cheerfully
 * shows the previous deployment's counterparties and looks like it is lying.
 *
 * Run after `pnpm deploy:testnet`:
 *
 *   pnpm tsx scripts/sync-worker-config.ts
 *
 * Deliberately edits wrangler.jsonc in place rather than regenerating it: that file
 * carries the reasoning for every value in it, and regenerating would throw the
 * comments away.
 */

import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

type Deployment = {
  registry: string;
  vault: string;
  chainId: number;
  network: string;
  deployedAt: string;
};

/** The chain ids this site knows, so a deployment cannot point it at a stranger. */
const KNOWN_CHAINS: Record<string, number> = {
  "arc-testnet": 5042002,
  "arc-mainnet": 5042,
};

/**
 * Which config file belongs to which network.
 *
 * Two Workers, two configs, one source of truth each. The alternative — one file
 * edited back and forth — is how a site ends up reading mainnet contracts through a
 * testnet explorer, which renders as broken links rather than as a wrong claim.
 */
const CONFIG_FOR: Record<string, string> = {
  "arc-testnet": "wrangler.jsonc",
  "arc-mainnet": "wrangler.mainnet.jsonc",
};

function main(): void {
  const wanted = process.argv[2];
  const path = wanted ? CONFIG_FOR[wanted] : "wrangler.jsonc";
  if (wanted && !path) {
    throw new Error(
      `No config file is mapped to "${wanted}". Known: ${Object.keys(CONFIG_FOR).join(", ")}.`,
    );
  }
  if (!existsSync(resolve(path)) && wanted) {
    throw new Error(
      `${path} does not exist yet. The mainnet config is created once, by hand, ` +
        `with the same variable names as wrangler.jsonc and HOROS_NETWORK=arc-mainnet.`,
    );
  }
  const source = wanted ? resolve("deployments", `${wanted}.json`) : resolve("deployment.json");
  if (!existsSync(source)) {
    throw new Error(`${source} does not exist — deploy to ${wanted ?? "the current network"} first.`);
  }
  const deployment = JSON.parse(readFileSync(source, "utf8")) as Deployment;

  const addr = /^0x[0-9a-fA-F]{40}$/;
  if (!addr.test(deployment.registry) || !addr.test(deployment.vault)) {
    throw new Error(
      `deployment.json does not contain two addresses (registry=${deployment.registry}, vault=${deployment.vault}). ` +
        `Refusing to point the site at something that is not a deployment.`,
    );
  }

  const before = readFileSync(resolve(path), "utf8");

  // The network travels with the addresses. Pointing the site at mainnet contracts
  // while its own configuration still says testnet is the failure this prevents:
  // every explorer link would lead to a chain that has never heard of the registry.
  const expected = KNOWN_CHAINS[deployment.network];
  if (expected === undefined) {
    throw new Error(
      `deployment.json says network "${deployment.network}", which this site does not know. ` +
        `Known: ${Object.keys(KNOWN_CHAINS).join(", ")}. Add it to KNOWN_CHAINS here and to ` +
        `NETWORKS in worker/src/config.ts, or fix the deployment.`,
    );
  }
  if (deployment.chainId !== expected) {
    throw new Error(
      `deployment.json says ${deployment.network} but chainId ${deployment.chainId}; ` +
        `${deployment.network} is ${expected}. Refusing to point the site at a contradiction.`,
    );
  }

  const after = before
    .replace(/("HOROS_NETWORK":\s*")[^"]*(")/, `$1${deployment.network}$2`)
    .replace(/("REGISTRY_ADDRESS":\s*")[^"]*(")/, `$1${deployment.registry}$2`)
    .replace(/("VAULT_ADDRESS":\s*")[^"]*(")/, `$1${deployment.vault}$2`);

  if (after === before) {
    console.log(`${path} already points at ${deployment.network} (registry ${deployment.registry})`);
    return;
  }

  writeFileSync(resolve(path), after);
  console.log(
    `${path} now points at ${deployment.network} (chain ${deployment.chainId}):\n` +
      `  registry  ${deployment.registry}\n` +
      `  vault     ${deployment.vault}\n` +
      `  deployed  ${deployment.deployedAt}\n\n` +
      `Deploy the site with:  pnpm site:deploy`,
  );
}

main();

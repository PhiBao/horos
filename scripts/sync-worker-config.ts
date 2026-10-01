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

import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

type Deployment = {
  registry: string;
  vault: string;
  chainId: number;
  network: string;
  deployedAt: string;
};

function main(): void {
  const deployment = JSON.parse(readFileSync(resolve("deployment.json"), "utf8")) as Deployment;

  const addr = /^0x[0-9a-fA-F]{40}$/;
  if (!addr.test(deployment.registry) || !addr.test(deployment.vault)) {
    throw new Error(
      `deployment.json does not contain two addresses (registry=${deployment.registry}, vault=${deployment.vault}). ` +
        `Refusing to point the site at something that is not a deployment.`,
    );
  }

  const path = resolve("wrangler.jsonc");
  const before = readFileSync(path, "utf8");

  const after = before
    .replace(/("REGISTRY_ADDRESS":\s*")[^"]*(")/, `$1${deployment.registry}$2`)
    .replace(/("VAULT_ADDRESS":\s*")[^"]*(")/, `$1${deployment.vault}$2`);

  if (after === before) {
    console.log(`wrangler.jsonc already points at ${deployment.network} (registry ${deployment.registry})`);
    return;
  }

  writeFileSync(path, after);
  console.log(
    `wrangler.jsonc now points at ${deployment.network}:\n` +
      `  registry  ${deployment.registry}\n` +
      `  vault     ${deployment.vault}\n` +
      `  deployed  ${deployment.deployedAt}\n\n` +
      `Deploy the site with:  pnpm site:deploy`,
  );
}

main();

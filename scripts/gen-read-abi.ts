/**
 * Regenerate worker/src/abi.ts from the compiled contract.
 *
 * The deployed site cannot import the forge artifact - contracts/out is a
 * gitignored build product, and reading it needs node:fs, which does not exist on
 * the edge. So the read ABI is checked in as a plain constant, and this script is
 * what keeps it honest.
 *
 * Run after `pnpm contract:build`:
 *
 *   pnpm tsx scripts/gen-read-abi.ts
 *
 * It emits read functions only. That restriction is the point rather than an
 * accident: the public page hands anybody a counterparty's entire payment history,
 * and it is served by an ABI that contains no way to move money. If a read
 * function is added here it has to be added deliberately.
 */

import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

/** The functions the public site and the decision card are allowed to call. */
const KEEP = new Set([
  "MAX_PROPOSAL_WINDOW",
  "MIN_PROPOSAL_WINDOW",
  "SUCCESSION_ATTESTATION_TYPEHASH",
  "activeAccount",
  "canonicalNameHash",
  "counterpartyIdFor",
  "get",
  "isPayable",
  "isPayer",
  "lineage",
  "nameIndex",
  "payerPaymentCount",
  "payerTotalPaid",
  "status",
  "succession",
  "successionsOf",
]);

const HEADER = `/**
 * The read side of CounterpartyRegistry and CustodyVault, as plain constants.
 *
 * Not imported from the forge artifacts, for two reasons. They live in
 * contracts/out, which is gitignored because it is a build product; and reading them
 * needs node:fs, which does not exist on the edge. So these are the ABIs the
 * deployed site actually uses, checked in, generated from the artifacts by
 * scripts/gen-read-abi.ts - which is in the repo so the two can be diffed.
 *
 * Read functions only, and that restriction is the property worth being able to
 * point at rather than an accident. The public page hands anybody a counterparty's
 * entire payment history and a vault's balances, and it is served by ABIs that
 * contain no write function. There is no code path from this Worker to moving money.
 */

export const REGISTRY_READ_ABI = `;

const KEEP_VAULT = new Set([
  "balance",
  "counterpartyCap",
  "globalCap",
  "owner",
  "paused",
  "referenceAmount",
  "referenceUsed",
  "registry",
  "usdc",
]);

type Entry = {type: string; name?: string; stateMutability?: string};

function readOnly(artifactPath: string, keep: Set<string>, label: string): Entry[] {
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {abi: Entry[]};

  const kept = artifact.abi
    .filter((e) => e.type === "function" && keep.has(e.name ?? ""))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

  const missing = [...keep].filter((n) => !kept.some((e) => e.name === n));
  if (missing.length > 0) {
    throw new Error(
      `${label}: these expected read functions are missing from the compiled contract: ${missing.join(", ")}. ` +
        `If one was renamed, fix it in the contract and in the KEEP set here rather than letting the site ` +
        `silently read less than it claims to.`,
    );
  }

  const writes = kept.filter((e) => e.stateMutability === "nonpayable");
  if (writes.length > 0) {
    throw new Error(
      `${label}: refusing to emit a nonpayable function into a read ABI: ${writes.map((e) => e.name).join(", ")}`,
    );
  }

  return kept;
}

function main(): void {
  const registry = readOnly(
    resolve("contracts/out/CounterpartyRegistry.sol/CounterpartyRegistry.json"),
    KEEP,
    "CounterpartyRegistry",
  );
  const vault = readOnly(resolve("contracts/out/CustodyVault.sol/CustodyVault.json"), KEEP_VAULT, "CustodyVault");

  const out = resolve("worker/src/abi.ts");
  writeFileSync(
    out,
    `${HEADER}${JSON.stringify(registry, null, 2)} as const;\n\n` +
      `export const VAULT_READ_ABI = ${JSON.stringify(vault, null, 2)} as const;\n`,
  );
  console.log(
    `wrote ${out} — registry ${registry.length} read functions, vault ${vault.length}, 0 write functions`,
  );
}

main();

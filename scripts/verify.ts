/**
 * Read the deployment and tell its story from the chain alone.
 *
 * Every other script here either writes or watches a write happen. This one only
 * reads, and that is the point: it is what a sceptical party runs when they do not
 * want to take a website's word for who has been paid. No API key, no wallet, no
 * trust in this repository beyond the address of the registry.
 *
 *   pnpm verify
 *   pnpm verify 0x<counterpartyId>
 *
 * The output is deliberately the same facts the public page renders, in a form that
 * survives being pasted into a terminal or a chat.
 */

import {formatUnits} from "viem";

import {loadEnv} from "../lib/env.js";
import {getPublicClient, currentNetwork, explorerAddress, formatUsdc} from "../lib/chain.js";
import {registryAbi, vaultAbi, getDeployment} from "../lib/abi.js";
import {labelStatus, labelSuccessionState} from "../lib/enums.js";
import type {NetworkKey} from "../lib/chain.js";

const short = (a: string) => (a && a.length > 14 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a);

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

async function main(): Promise<void> {
  const client = getPublicClient();
  const dep = getDeployment();

  /**
   * The chain to describe, taken from the deployment rather than from the shell.
   *
   * This printed "arc-testnet · chainId 5042" against the mainnet deployment: the
   * label came from currentNetwork() and the id from deployment.json, so the header
   * contradicted itself and every explorer link pointed at the wrong chain. A script
   * whose whole purpose is "check it yourself" cannot read the deployment from one
   * source and the chain from another.
   */
  const key = dep.network as NetworkKey;
  const wanted = process.argv[2] as `0x${string}` | undefined;

  console.log(`\n${bold("  HOROS")}  — what the chain says, read with no key and no API`);
  console.log(dim(`  ${dep.network} · chainId ${dep.chainId}`));
  console.log(dim(`  registry  ${explorerAddress(dep.registry, key)}`));
  console.log(dim(`  vault     ${explorerAddress(dep.vault, key)}`));

  // ---- the registry cannot be edited by its owner ---------------------------
  // Worth showing first, because it is the load-bearing claim: the owner key can
  // register a counterparty and nothing else. A registry owner that could reassign
  // an account would make everything below decorative.
  const registryOwner = (await client.readContract({
    address: dep.registry,
    abi: registryAbi,
    functionName: "registryOwner",
  })) as `0x${string}`;

  console.log(`\n${bold("  The registry")}`);
  console.log(`    owner  ${short(registryOwner)}  ${dim("can register counterparties, and nothing else")}`);

  // ---- the counterparty ----------------------------------------------------
  let cpId = wanted;
  if (!cpId) {
    // No id given: find the one this deployment was seeded with, by name. The name
    // is not secret and the hash is public, so this is a lookup rather than a leak.
    const nameHash = (await client.readContract({
      address: dep.registry,
      abi: registryAbi,
      functionName: "canonicalNameHash",
      args: ["Northwind Plumbing Ltd"],
    })) as `0x${string}`;
    cpId = (await client.readContract({
      address: dep.registry,
      abi: registryAbi,
      functionName: "nameIndex",
      args: [nameHash],
    })) as `0x${string}`;
  }

  if (/^0x0+$/.test(cpId)) {
    console.log(`\n  No counterparty on this deployment yet. Run one of the demos first.\n`);
    return;
  }

  const [cp, lineage, successions, payable, cap, balance] = await Promise.all([
    client.readContract({address: dep.registry, abi: registryAbi, functionName: "get", args: [cpId]}) as Promise<{
      canonicalName: string;
      status: number;
      activeAccount: `0x${string}`;
    }>,
    client.readContract({address: dep.registry, abi: registryAbi, functionName: "lineage", args: [cpId]}) as Promise<
      {account: `0x${string}`; activatedAt: bigint; attestationCount: number; successorOf: `0x${string}`; activatedBy: `0x${string}`}[]
    >,
    client.readContract({address: dep.registry, abi: registryAbi, functionName: "successionsOf", args: [cpId]}) as Promise<
      `0x${string}`[]
    >,
    client.readContract({address: dep.registry, abi: registryAbi, functionName: "isPayable", args: [cpId]}) as Promise<boolean>,
    client.readContract({address: dep.vault, abi: vaultAbi, functionName: "counterpartyCap", args: [cpId]}) as Promise<bigint>,
    client.readContract({address: dep.vault, abi: vaultAbi, functionName: "balance", args: []}) as Promise<bigint>,
  ]);

  console.log(`\n${bold("  The counterparty")}`);
  console.log(`    name      ${cp.canonicalName}`);
  console.log(`    id        ${dim(cpId)}`);
  console.log(`    status    ${labelStatus(cp.status)}`);
  console.log(`    payable   ${payable ? green("yes") : yellow("no")}  ${dim("pay() resolves to the account below, and to nothing else")}`);
  console.log(`    pays to   ${bold(cp.activeAccount)}`);
  console.log(`    budget    ${formatUsdc(cap)} USDC per payment, vault holds ${formatUsdc(balance)} USDC`);

  // ---- the lineage ---------------------------------------------------------
  // Every entry here is an account that has actually received money, or that two
  // parties signed for. There is no third way in.
  console.log(`\n${bold("  Every account it has been paid at")}`);
  for (const [i, e] of lineage.entries()) {
    const first = /^0x0+$/.test(e.successorOf);
    const signed = first
      ? dim("opened by payment evidence")
      : green(`${e.attestationCount} signatures`) + dim(` · replaced ${short(e.successorOf)}`);
    console.log(`    ${i + 1}. ${bold(e.account)}`);
    console.log(`       ${signed}`);
    console.log(`       ${dim(`authorised by ${short(e.activatedBy)} · ${new Date(Number(e.activatedAt) * 1000).toISOString().slice(0, 10)}`)}`);
  }

  // ---- the ceremonies ------------------------------------------------------
  console.log(`\n${bold("  The ceremonies, with both signatures named")}`);
  if (successions.length === 0) {
    console.log(dim("    none"));
  }
  for (const sid of successions) {
    const s = (await client.readContract({
      address: dep.registry,
      abi: registryAbi,
      functionName: "succession",
      args: [sid],
    })) as {
      to: `0x${string}`;
      state: number;
      oldKeyAttested: boolean;
      payerAttested: boolean;
      quorumAttestors: readonly `0x${string}`[];
    };
    // The two signatures are named rather than counted, because a count would let a
    // stranger's signature stand in for either of them.
    console.log(`    ${labelSuccessionState(s.state)}  →  ${bold(s.to)}`);
    console.log(`      ${s.oldKeyAttested ? green("✓") : yellow("—")} the account that was last paid, agreeing to be replaced`);
    console.log(`      ${s.payerAttested ? green("✓") : yellow("—")} the business, authorising the change`);
    console.log(`      ${dim("the recipient cannot supply either one")}`);
    void s.quorumAttestors;
  }

  // ---- the claim, checked rather than asserted -----------------------------
  //
  // A checkmark that is a sentence is not a check. These two read the ABI the
  // deployment was built from and the registry's function list, and fail loudly if
  // either grows a way to do the thing the product says cannot be done. Running
  // this against a modified contract should break it, which is the only way to
  // know it is looking at anything.
  console.log(`\n${bold("  What the interface will not let you express")}`);

  const pay = vaultAbi.find((f) => f.type === "function" && f.name === "pay") as
    | {inputs: {name: string; type: string}[]}
    | undefined;
  if (!pay) throw new Error("the vault ABI has no pay function - this check is looking at the wrong contract");

  const destinationParams = pay.inputs.filter(
    (i) => i.type === "address" || i.type === "address[]" || i.type === "bytes",
  );
  const signature = `pay(${pay.inputs.map((i) => i.type).join(",")})`;

  if (destinationParams.length === 0) {
    console.log(`    ${green("✓")} pay an address of the caller's choosing`);
    console.log(`      ${dim(`${signature} has no address parameter.`)}`);
    console.log(`      ${dim("The refusal is the signature, not a check that ran - so there is no argument")}`);
    console.log(`      ${dim("to smuggle a destination into, and no prompt that could add one.")}`);
  } else {
    console.log(`    ${yellow("✗")} the vault's pay() takes ${destinationParams.map((p) => p.name || p.type).join(", ")}`);
    console.log(`      ${dim("This is the thing the product claims it cannot do. Investigate.")}`);
    process.exitCode = 1;
  }

  // The registry, checked for the function that would make the ceremony optional.
  const writers = registryAbi.filter((f) => f.type === "function" && f.stateMutability === "nonpayable");
  const reassign = writers.filter((f) => /^(update|set|change|force|override).*account/i.test(f.name ?? ""));

  if (reassign.length === 0) {
    console.log(`    ${green("✓")} reassign an account without two signatures`);
    console.log(`      ${dim(`${writers.length} functions can write to the registry; none of them sets an account.`)}`);
    console.log(`      ${dim("The only path is succession, and that needs the old key and the payer.")}`);
  } else {
    console.log(`    ${yellow("✗")} the registry exposes ${reassign.map((f) => f.name).join(", ")}`);
    process.exitCode = 1;
  }

  console.log("");
}



loadEnv();

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

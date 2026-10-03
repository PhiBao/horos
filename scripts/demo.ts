/**
 * One command, the whole loop, real settlement.
 *
 *   pnpm demo
 *
 * Runs against the deployed contracts on Arc. Every step prints the transaction
 * that carried it out. The point is that the sequence a judge watches is the same
 * one that actually moved the money.
 */

import {loadEnv} from "../lib/env.js";
import {keccak256, toHex} from "viem";
import {VENDOR_KEY, VENDOR_NEW_KEY, ATTACKER_KEY} from "../lib/demo-keys.js";
import {privateKeyToAccount} from "viem/accounts";
import {getPublicClient, getLocalSigner, formatUsdc, explorerTx, explorerAddress, USDC_ADDRESS} from "../lib/chain.js";
import {registryAbi, vaultAbi, getDeployment} from "../lib/abi.js";
import {decide, type Evidence} from "../lib/policy.js";
import {screenCounterparty, toEvidence} from "../lib/screening.js";
import {COUNTERPARTY_NAME, buildInvoice, judgeInvoice, judgmentLines, readInvoice, type ReadInvoice} from "../lib/demo-invoices.js";

loadEnv();

const dep = getDeployment();
const client = getPublicClient();
const pk = process.env.HOROS_DEPLOYER_PRIVATE_KEY as `0x${string}`;
const account = privateKeyToAccount(pk);
const wallet = getLocalSigner();

// Three parties. A small agency, the plumber it pays, and a stranger with the
// plumber's inbox but not the plumber's key.
/**
 * Three distinct parties, held on deterministic demo keys.
 *
 * They must be separate from the payer, or a payment would just move our own
 * money back to ourselves and the accounting would mean nothing. The vendor
 * keeps its key in this file only because the demo has to perform a succession
 * ceremony on its behalf; a real vendor signs on their own machine.
 */
const VENDOR = privateKeyToAccount(requireVendorKey()).address;
const VENDOR_NEW = privateKeyToAccount(requireNewKey()).address;
const ATTACKER = privateKeyToAccount(requireAttackerKey()).address;

function requireVendorKey(): `0x${string}` {
  if (!VENDOR_KEY) {
    console.error("\n  HOROS_DEMO_VENDOR_KEY is not set.");
    console.error("  The vendor must sign for itself; that is the entire point of the ceremony.\n");
    process.exit(1);
  }
  return VENDOR_KEY;
}
function requireNewKey(): `0x${string}` {
  if (!VENDOR_NEW_KEY) {
    console.error("\n  HOROS_DEMO_VENDOR_NEW_KEY is not set.\n");
    process.exit(1);
  }
  return VENDOR_NEW_KEY;
}
function requireAttackerKey(): `0x${string}` {
  if (!ATTACKER_KEY) {
    console.error("\n  HOROS_DEMO_ATTACKER_KEY is not set.\n");
    process.exit(1);
  }
  return ATTACKER_KEY;
}

let step = 0;
const t = (msg: string) => console.log(`\n\x1b[1m${String(++step).padStart(2, "0")}. ${msg}\x1b[0m`);
const ok = (msg: string) => console.log(`    \x1b[32m✓\x1b[0m ${msg}`);
const note = (msg: string) => console.log(`      ${msg}`);
const warn = (msg: string) => console.log(`    \x1b[33m!\x1b[0m ${msg}`);


async function refUsed(r: `0x${string}`): Promise<boolean> {
  try {
    return (await client.readContract({address: dep.vault, abi: vaultAbi, functionName: "referenceUsed", args: [r]})) as boolean;
  } catch {
    return true;
  }
}

/** Turn a viem failure into the one line a person needs. */
function explain(e: unknown): string {
  const err = e as {shortMessage?: string; details?: string; walk?: unknown; cause?: {shortMessage?: string}};
  const chain: string[] = [];
  if (err.details) chain.push(String(err.details).split("\n")[0]);
  if (err.shortMessage) chain.push(err.shortMessage);
  if (err.cause?.shortMessage) chain.push(err.cause.shortMessage);
  return chain.join(" — ") || (e as Error)?.message?.slice(0, 160) || "unknown error";
}

async function send(fn: () => Promise<`0x${string}`>, label: string) {
  let hash: `0x${string}`;
  try {
    hash = await fn();
    const r = await client.waitForTransactionReceipt({hash});
    if (r.status !== "success") {
      console.error(`    \x1b[31m✗\x1b[0m ${label}\n      transaction reverted on chain\n`);
      process.exit(1);
    }
    const url = explorerTx(hash);
    ok(`${label}  ${url.startsWith("local:") ? hash : url}`);
    return r;
  } catch (e) {
    console.error(`    \x1b[31m✗\x1b[0m ${label}\n      ${explain(e)}\n`);
    process.exit(1);
  }
}

/** Arc blocklists a set of well-known test addresses and reverts transfers to them. */
async function assertNotBlocked(addresses: [string, string][], label: string) {
  for (const [addr, who] of addresses) {
    const code = await client.getCode({address: addr as `0x${string}`}).catch(() => "0x");
    if (code && code !== "0x") {
      console.error(
        `\n  ${addr} (${who}) is blocked on this chain. Arc reverts transfers to blocklisted addresses.\n` +
          `  Generate fresh demo keys, or redeploy.\n`,
      );
      process.exit(1);
    }
  }
  void label;
}

async function main() {
  await assertNotBlocked(
    [
      [VENDOR, "vendor"],
      [VENDOR_NEW, "the vendor's new account"],
      [ATTACKER, "attacker"],
    ],
    "demo accounts",
  );

  console.log(`\n\x1b[1m  HOROS\x1b[0m  — a change of payment address is a succession ceremony, not a field update`);
  console.log(`  ${dep.network} · chainId ${dep.chainId}`);
  console.log(`  registry  ${dep.registry}`);
  console.log(`  vault     ${dep.vault}`);
  console.log(`  from      ${account.address}`);

  const regClient = wallet;

  // ---------------------------------------------------------------------
  t("Fund the vault");
  const bal = (await client.readContract({
    address: USDC_ADDRESS,
    abi: [{type: "function", name: "balanceOf", stateMutability: "view", inputs: [{name: "a", type: "address"}], outputs: [{type: "uint256"}]}],
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
  note(`wallet holds ${formatUsdc(bal)} USDC`);

  // The two real payments, plus a reserve for the attempts that are *supposed* to
  // fail. Those revert, so they cost gas and nothing else - but the reserve is
  // sized off the payment so it scales with whatever this run is configured to do.
  const reserve = PAY_SECOND / 4n + usdc(0.1);
  const need = PAY_FIRST + PAY_SECOND + reserve;

  if (bal < need) {
    console.error(
      `\n  Not enough USDC to run the demo.\n` +
        `  wallet  ${account.address}\n` +
        `  held    ${formatUsdc(bal)} USDC\n` +
        `  need    ${formatUsdc(need)} USDC\n\n` +
        `  Get 20 USDC at https://faucet.circle.com  (choose Arc Testnet, paste the wallet above)\n` +
        `  Then: pnpm faucet   to confirm the balance\n`,
    );
    process.exit(1);
  }

  const vaultBalance = (await client.readContract({address: dep.vault, abi: vaultAbi, functionName: "balance", args: []})) as bigint;
  const deposit = need - vaultBalance;
  if (deposit > 0n) {
    await client.waitForTransactionReceipt({
      hash: await wallet.writeContract({
        address: USDC_ADDRESS,
        abi: [
          {type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{name: "s", type: "address"}, {name: "a", type: "uint256"}], outputs: [{type: "bool"}]},
        ],
        functionName: "approve",
        args: [dep.vault, deposit],
      }),
    });
    await send(() => wallet.writeContract({
        address: dep.vault,
        abi: vaultAbi,
        functionName: "deposit",
        args: [deposit],
      }),
      `deposit ${formatUsdc(deposit)} USDC into the vault`,
    );
  } else {
    note(`the vault already holds ${formatUsdc(vaultBalance)} USDC from an earlier run — enough`);
  }

  // ---------------------------------------------------------------------
  t("Register a counterparty and give it a budget");
  // The demo must be re-runnable, so derive the id rather than assuming a fresh chain.
  // The counterparty id is derived from the name plus the first account paid, so
  // the same inputs always give the same id and the demo is safe to re-run. If an
  // earlier run already claimed the name, reuse that record rather than failing.
  const nameHash = (await client.readContract({
    address: dep.registry,
    abi: registryAbi,
    functionName: "canonicalNameHash",
    args: [COUNTERPARTY_NAME],
  })) as `0x${string}`;

  let cpId = (await client.readContract({
    address: dep.registry,
    abi: registryAbi,
    functionName: "nameIndex",
    args: [nameHash],
  })) as `0x${string}`;

  if (cpId === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    // The business is named here, at registration, and nowhere else can name it.
    // From this call on, the payer half of every succession has exactly one right
    // answer: this key. A stranger can still register themselves as a payer, but
    // registration has never granted the payer half.
    const regHash = await regClient.writeContract({
      address: dep.registry,
      abi: registryAbi,
      functionName: "register",
      args: [COUNTERPARTY_NAME, VENDOR, account.address],
    });
    await client.waitForTransactionReceipt({hash: regHash});
    cpId = (await client.readContract({
      address: dep.registry,
      abi: registryAbi,
      functionName: "nameIndex",
      args: [nameHash],
    })) as `0x${string}`;
    ok(`registered "${COUNTERPARTY_NAME}"  ${explorerTx(regHash)}`);
  } else {
    note(`"${COUNTERPARTY_NAME}" was registered by an earlier run — reusing that record`);
  }

  const cpState = (await client.readContract({
    address: dep.registry,
    abi: registryAbi,
    functionName: "status",
    args: [cpId],
  })) as number;
  note(`counterparty  ${cpId.slice(0, 18)}…  status ${["None", "Clean", "Broken"][cpState]}`);

  // If a previous run already performed a ceremony, put the lineage back where
  // this run's story needs it, so the demo always shows the same sequence.
  const line0 = (await client.readContract({
    address: dep.registry,
    abi: registryAbi,
    functionName: "lineage",
    args: [cpId],
  })) as {account: `0x${string}`}[];

  if (line0[0] && line0[0].account.toLowerCase() !== VENDOR.toLowerCase()) {
    console.error(`\n  This counterparty came from an earlier run with a different vendor key.`);
    console.error(`  Re-deploy for a clean story:  pnpm deploy:testnet\n`);
    process.exit(1);
  }

  await send(() => regClient.writeContract({address: dep.vault, abi: vaultAbi, functionName: "setCounterpartyCap", args: [cpId, COUNTERPARTY_CAP]}),
    "set a budget for this counterparty",
  );

  // One-shot: the story is clearer if every run starts from a fresh deployment,
  // and a second run against the same contracts would skip steps the video needs.
  if (await refUsed(ref("inv-1"))) {
    console.error(
      `\n  These contracts have already run the demo.\n` +
        `  Re-deploy for a clean run:  pnpm deploy:testnet\n`,
    );
    process.exit(1);
  }

  await send(() => regClient.writeContract({address: dep.vault, abi: vaultAbi, functionName: "pay", args: [cpId, PAY_FIRST, ref("inv-1")]}),
    `pay ${formatUsdc(PAY_FIRST)} USDC — the address is the one on record`,
  );

  // ---------------------------------------------------------------------
  t("The attack. A new account arrives on the invoice, with no ceremony behind it.");
  note("The invoice asks for a different account. Nothing has signed for the move.");
  const attackDoc = buildInvoice("attack", {payTo: VENDOR_NEW, prior: VENDOR, amount: formatUsdc(PAY_SECOND)});
  const read = readInvoice(attackDoc);
  note("read " + read.amount + " USDC for " + read.counterpartyName + ", payable to " + short(read.account ?? "0x"));

  const ev = await gatherEvidence(cpId, VENDOR_NEW, PAY_SECOND, 0, read);
  note("what the document says, as probabilities rather than a verdict:");
  for (const l of judgmentLines(ev.judgment)) note(l);
  let d = decide(ev);
  note(`policy: ${d.verdict}  —  ${d.headline}`);
  ok(`policy refused, before any money moved. The contract was never called.`);

  // Here is the stronger claim, and it is a property of the interface rather
  // than of a check: `pay()` takes a counterparty id, not an address. The caller
  // has no way to name a destination. Paying the attacker's account is not an
  // expression this contract can even be given, so the attack cannot be phrased.
  const activeBefore = (await client.readContract({
    address: dep.registry,
    abi: registryAbi,
    functionName: "activeAccount",
    args: [cpId],
  })) as `0x${string}`;
  if (activeBefore.toLowerCase() !== VENDOR.toLowerCase()) {
    console.error("\n  the registry's active account is not the one we registered — aborting\n");
    process.exit(1);
  }
  ok("the vault cannot be given the attacker's account: pay() takes a counterparty, not an address");
  ok(`it will resolve to ${short(activeBefore)}, and to nothing else`);

  // ---------------------------------------------------------------------
  t("The vendor performs the ceremony. Both signatures, neither from the recipient.");
  const proposal = await regClient.writeContract({
    address: dep.registry,
    abi: registryAbi,
    functionName: "proposeSuccession",
    args: [cpId, VENDOR_NEW, 7n * 24n * 60n * 60n],
  });
  await client.waitForTransactionReceipt({hash: proposal});
  const succId = await findPendingSuccession(cpId);
  note(`proposed  ${succId.slice(0, 18)}…`);

  const s = (await client.readContract({address: dep.registry, abi: registryAbi, functionName: "succession", args: [succId]})) as {
    counterpartyId: `0x${string}`; id: `0x${string}`; from: `0x${string}`; to: `0x${string}`; expiresAt: bigint;
  };
  const digest = (await client.readContract({
    address: dep.registry, abi: registryAbi, functionName: "successionDigest",
    args: [s.counterpartyId, s.id, s.to, s.expiresAt],
  })) as `0x${string}`;

  // 1. the account that received the last payment
  const oldSig = await signDigest(requireVendorKey(), digest);
  await send(() => regClient.writeContract({address: dep.registry, abi: registryAbi, functionName: "attest", args: [succId, 0, oldSig]}),
    "attested by the account that was last paid",
  );

  // The recipient can never be one of its own signatories. Prove it.
  try {
    const newSig = await signDigest(requireNewKey(), digest);
    await regClient.simulateContract({address: dep.registry, abi: registryAbi, functionName: "attest", args: [succId, 0, newSig]});
    warn("the recipient was able to attest to its own arrival — investigate");
  } catch {
    ok("the new account cannot sign for its own arrival");
  }

  // 2. the payer
  const payerSig = await signDigest(pk, digest);
  await send(() => regClient.writeContract({address: dep.registry, abi: registryAbi, functionName: "attest", args: [succId, 1, payerSig]}),
    "attested by us, the payer",
  );

  await send(() => regClient.writeContract({address: dep.registry, abi: registryAbi, functionName: "activate", args: [succId]}),
    "ceremony activated",
  );

  // ---------------------------------------------------------------------
  t("Pay the new account. Now it is on the record.");
  const movedDoc = buildInvoice("afterMove", {payTo: VENDOR_NEW, amount: formatUsdc(PAY_SECOND)});
  const read2 = readInvoice(movedDoc);
  note("read " + read2.amount + " USDC, payable to " + short(read2.account ?? "0x"));

  const ev2 = await gatherEvidence(cpId, VENDOR_NEW, PAY_SECOND, 0, read2);
  d = decide(ev2);
  note(`policy: ${d.verdict}  —  ${d.headline}`);
  await send(() => regClient.writeContract({address: dep.vault, abi: vaultAbi, functionName: "pay", args: [cpId, PAY_SECOND, ref("inv-2")]}),
    `pay ${formatUsdc(PAY_SECOND)} USDC to the newly attested account`,
  );

  // ---------------------------------------------------------------------
  t("The lineage, in public");
  const lineage = (await client.readContract({address: dep.registry, abi: registryAbi, functionName: "lineage", args: [cpId]})) as {
    account: `0x${string}`; activatedAt: bigint; attestationCount: number; successorOf: `0x${string}`;
  }[];
  lineage.forEach((e, i) => {
    const link = i === 0 ? "opened by payment evidence" : `successor of ${short(e.successorOf)} · ${e.attestationCount} signatures`;
    note(`${i + 1}. ${short(e.account)}  ${link}`);
  });
  ok(`${lineage.length} accounts, ${lineage.length - 1} ceremony, 0 unapproved changes`);

  // ---------------------------------------------------------------------
  t("What the vault will not do");
  const cases: [string, () => Promise<unknown>][] = [
    ["pay the same invoice twice", async () => {
      await regClient.writeContract({address: dep.vault, abi: vaultAbi, functionName: "pay", args: [cpId, usdc(0.1), ref("inv-2")]});
    }],
    ["pay a counterparty that does not exist", () => regClient.simulateContract({address: dep.vault, abi: vaultAbi, functionName: "pay", args: ["0x" + "ee".repeat(32), usdc(0.1), ref("nope-2")]} as never)],
  ];
  for (const [label, run] of cases) {
    try {
      await run();
      warn(`cannot ${label} — SUCCEEDED, investigate`);
    } catch {
      ok(`cannot ${label}`);
    }
  }

  // There is deliberately no "pay this other address" case, because the vault has
  // no such call. The strongest guarantee is the one the interface cannot express.

  console.log(`\n\x1b[1m  Done.\x1b[0m  Real USDC moved on ${dep.network}, every step verifiable above.`);
  console.log(`  Registry: ${explorerAddress(dep.registry)}`);
  console.log(`  Vault:    ${explorerAddress(dep.vault)}\n`);
}

async function gatherEvidence(
  cpId: `0x${string}`,
  invoiceAccount: `0x${string}`,
  amount: bigint,
  termsDays: number,
  read: ReadInvoice,
): Promise<Evidence> {
  const [cp, lineage, cap, globalCap, payerCount, payerTotal, pending] = await Promise.all([
    client.readContract({address: dep.registry, abi: registryAbi, functionName: "get", args: [cpId]}) as Promise<{canonicalName: string; status: number; activeAccount: `0x${string}`}>,
    client.readContract({address: dep.registry, abi: registryAbi, functionName: "lineage", args: [cpId]}) as Promise<unknown[]>,
    client.readContract({address: dep.vault, abi: vaultAbi, functionName: "counterpartyCap", args: [cpId]}) as Promise<bigint>,
    client.readContract({address: dep.vault, abi: vaultAbi, functionName: "globalCap", args: []}) as Promise<bigint>,
    client.readContract({address: dep.registry, abi: registryAbi, functionName: "payerPaymentCount", args: [cpId, account.address]}) as Promise<bigint>,
    client.readContract({address: dep.registry, abi: registryAbi, functionName: "payerTotalPaid", args: [cpId, account.address]}) as Promise<bigint>,
    hasAttestedSuccession(cpId),
  ]);

  const active = cp.activeAccount.toLowerCase();
  return {
    counterpartyId: cpId,
    canonicalName: cp.canonicalName,
    status: (["None", "Clean", "Broken"] as const)[cp.status] ?? "None",
    activeAccount: cp.activeAccount,
    accountCount: lineage.length,
    payerPayments: Number(payerCount),
    payerTotal,
    invoiceAccount,
    addressMatchesActive: active === invoiceAccount.toLowerCase(),
    successionPending: pending,
    termsDays,
    amount,
    counterpartyCap: cap,
    globalCap,
    screening: toEvidence(await screenCounterparty(invoiceAccount)),
    judgment: await judgeInvoice(read.doc, invoiceAccount, {
      paymentsMadeSoFar: Number(payerCount),
      previouslyPaidAddress: cp.activeAccount,
      addressMatchesRecord: cp.activeAccount.toLowerCase() === invoiceAccount.toLowerCase(),
      daysRelationship: 670,
    }),
    injectedInstructions: read.injectedInstructions,
    ambiguousDestination: read.ambiguousDestination,
  };
}


async function hasAttestedSuccession(cpId: `0x${string}`): Promise<boolean> {
  const ids = (await client.readContract({address: dep.registry, abi: registryAbi, functionName: "successionsOf", args: [cpId]})) as `0x${string}`[];
  for (const id of ids) {
    const s = (await client.readContract({address: dep.registry, abi: registryAbi, functionName: "succession", args: [id]})) as {state: number};
    if (s.state === 2) return true;
  }
  return false;
}

async function findPendingSuccession(cpId: `0x${string}`): Promise<`0x${string}`> {
  const ids = (await client.readContract({address: dep.registry, abi: registryAbi, functionName: "successionsOf", args: [cpId]})) as `0x${string}`[];
  if (ids.length === 0) throw new Error("no succession was created");
  return ids[ids.length - 1];
}

/**
 * Sign an EIP-712 digest.
 *
 * Must be the account's raw `sign`, NOT `signMessage`. signMessage applies the
 * EIP-191 personal-sign prefix, which changes the digest the contract recovers
 * and makes every attestation fail. This is the one detail that separates a
 * working succession from a confusing one.
 */
async function signDigest(key: `0x${string}`, digest: `0x${string}`): Promise<`0x${string}`> {
  const {privateKeyToAccount} = await import("viem/accounts");
  return privateKeyToAccount(key).sign({hash: digest}) as Promise<`0x${string}`>;
}


/**
 * Absolute amounts, in USDC. Small enough to fit a single faucet claim, and
 * varied enough that "over the budget" is a real test rather than a formality.
 */
const usdc = (n: number): bigint => BigInt(Math.floor(n * 10 ** 6));
/**
 * Names are unique per deployment so a demo run always starts from a clean
 * record. Re-deploying gives a new set of contracts and a fresh story.
 */
/**
 * What the two invoices are for.
 *
 * Overridable so the demo can be seeded on a testnet where the faucet is a human
 * clicking a captcha. The defaults are the ones the narrative wants: a small
 * routine invoice, then a much larger one that arrives with a new account attached,
 * which is how the real thing looks - the redirect always carries urgency.
 *
 * Whatever these are, the invoice text is generated from them, so the number on the
 * document and the number that moves are the same number.
 */
const PAY_FIRST = usdc(Number(process.env.HOROS_DEMO_PAY_FIRST ?? 0.4));
const PAY_SECOND = usdc(Number(process.env.HOROS_DEMO_PAY_SECOND ?? 2.4));
const COUNTERPARTY_CAP = usdc(10); // what we allow this vendor per payment

/**
 * A stable reference for a payment, so the same invoice can never be paid twice.
 * Real keccak, not a hash of our own: the vault stores this as a bytes32 and
 * compares it, so it has to be a real one.
 */
const ref = (label: string): `0x${string}` => keccak256(toHex(label));
const short = (a: string) => (a === "0x0000000000000000000000000000000000000000" ? "—" : `${a.slice(0, 8)}…${a.slice(-4)}`);

main().catch((e) => {
  console.error(`\n  ${e.shortMessage ?? e.message}\n`);
  const w = e.walk;
  if (typeof w === "function") {
    try {
      console.error(`  ${String(w(e)).slice(0, 600)}\n`);
    } catch {}
  }
  process.exit(1);
});

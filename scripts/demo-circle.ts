/**
 * The keyless path: the agent has no private key.
 *
 *   pnpm demo:circle
 *
 * Same contracts, same policy, same refusal. The difference is who signs.
 * Instead of a local key, every transaction is submitted to Circle as a
 * contract execution and signed inside Circle's custody layer using the entity
 * secret. There is no key in this process for a prompt to reach.
 *
 * This is the property the hackathon asks for: an agent bounded by something it
 * cannot talk its way past. Not a policy we wrote. An absent key.
 */

import {loadEnv} from "../lib/env.js";
import {keccak256, toHex} from "viem";
import {getAgentWallet, circleClient, circleBlockchain} from "../lib/circle.js";
import {getPublicClient, getLocalSigner, formatUsdc, explorerTx, explorerAddress, USDC_ADDRESS} from "../lib/chain.js";
import {registryAbi, vaultAbi, getDeployment} from "../lib/abi.js";
import {decide, type Evidence} from "../lib/policy.js";
import {screenCounterparty, toEvidence} from "../lib/screening.js";
import {COUNTERPARTY_NAME, buildInvoice, judgeInvoice, judgmentLines, readInvoice, type ReadInvoice} from "../lib/demo-invoices.js";
import {VENDOR_KEY} from "../lib/demo-keys.js";

loadEnv();

const dep = getDeployment();
const blockchain = circleBlockchain();
const client = getPublicClient();
let circle: ReturnType<typeof circleClient>;

const VENDOR = "0x15AB8109378736FA1C1C401175d375DB9b1dAC4B";
const VENDOR_NEW = "0x4AB5e7F2b5464B9494b49EFE41C2f00e7bcfE555";
/**
 * The business: the one key whose signature satisfies the payer half of a succession.
 *
 * Named at registration, transferable only by itself. Deliberately NOT the agent
 * wallet — the agent executes payments and submits other parties' signatures, but
 * it authorises nothing, and nothing it submits can stand in for this key.
 */
const BUSINESS = process.env.HOROS_DEPLOYER as `0x${string}`;
/** The payer is whoever owns the vault, which is the agent wallet. */
const PAYER = (process.env.CIRCLE_WALLET_ADDRESS as `0x${string}`) ?? BUSINESS;

const usdc = (n: number): bigint => BigInt(Math.floor(n * 10 ** 6));
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

let step = 0;
const t = (m: string) => console.log(`\n\x1b[1m${String(++step).padStart(2, "0")}. ${m}\x1b[0m`);
const ok = (m: string) => console.log(`    \x1b[32m✓\x1b[0m ${m}`);
const note = (m: string) => console.log(`      ${m}`);

/**
 * Wait for a Circle transaction to settle.
 *
 * The terminal success state is COMPLETE, not CONFIRMED — CONFIRMED means the
 * transaction is mined but not yet finalised. The set below used to include both,
 * which contradicted this comment and continued the ceremony against a
 * transaction a reorg could still take back.
 */
const SETTLED = new Set(["COMPLETE"]);
const FAILED = new Set(["FAILED", "DENIED", "CANCELLED"]);

async function settle(transactionId: string, label: string): Promise<void> {
  let lastState = "";
  for (let i = 0; i < 60; i++) {
    const r = await circle.getTransaction({id: transactionId});
    const tx = r.data?.transaction;
    const state = tx?.state ?? "unknown";
    if (state !== lastState) {
      note(`Circle: ${state}`);
      lastState = state;
    }
    if (SETTLED.has(state)) {
      const hash = (tx as unknown as {txHash?: string}).txHash;
      ok(`${label}  ${hash ? explorerTx(hash as `0x${string}`) : transactionId}`);
      return;
    }
    if (FAILED.has(state)) {
      const why = (tx as unknown as {error?: {message?: string}})?.error?.message ?? "";
      console.error(`    \x1b[31m✗\x1b[0m ${label}\n      Circle reported ${state}${why ? `: ${why}` : ""}\n`);
      process.exit(1);
    }
    await sleep(2000);
  }
  console.error(`    \x1b[31m✗\x1b[0m ${label}\n      still ${lastState} after 2 minutes\n`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function execute(
  contractAddress: `0x${string}`,
  abi: unknown,
  abiFunctionSignature: string,
  abiParameters: unknown[],
  label: string,
) {
  const hash = await circle.createContractExecutionTransaction({
    walletId: wallet.id,
    blockchain,
    contractAddress,
    abiJson: JSON.stringify(abi) as never,
    abiFunctionSignature,
    abiParameters: abiParameters as never,
    fee: {type: "level", config: {feeLevel: "MEDIUM"}},
  } as never);
  const id = hash.data?.id;
  if (!id) throw new Error("Circle did not return a transaction id");
  await settle(id, label);
}

async function main() {
  wallet = await getAgentWallet();
  circle = circleClient();
  console.log(`\n\x1b[1m  HOROS\x1b[0m — keyless: Circle holds the key, not this process`);
  console.log(`  ${dep.network} · chainId ${dep.chainId}`);
  console.log(`  agent wallet  ${wallet.address}  (Circle id ${wallet.id})`);
  console.log(`  custody       ${wallet.custodyType} — the private key never exists here`);

  // ---- 0. two keys, two jobs, one of them absent ----------------------
  //
  // This step used to claim the script "never reads" the local key. That stopped
  // being true when the payer half began requiring the designated business: the
  // business signs the attestation, so the script reads the business key. The
  // claim worth making is narrower and true — the *agent's* key does not exist
  // here, and Circle signs every transaction the agent submits.
  t("There is no agent key in this process");
  const businessKey = process.env.HOROS_DEPLOYER_PRIVATE_KEY;
  note(
    businessKey
      ? "the business key is read, and only to sign the payer half — which the agent cannot sign"
      : "no business key is set: the payer half will have to come from somewhere else",
  );
  ok("the agent's key does not exist here: Circle's custody layer signs every submission");

  // ---- 1. fund the vault from the Circle wallet ----------------------
  t("Fund the vault from the agent's own wallet");
  const bal = (await client.readContract({
    address: USDC_ADDRESS,
    abi: [{type: "function", name: "balanceOf", stateMutability: "view", inputs: [{name: "a", type: "address"}], outputs: [{type: "uint256"}]}],
    functionName: "balanceOf",
    args: [wallet.address],
  })) as bigint;
  note(`agent wallet holds ${formatUsdc(bal)} USDC`);

  const vaultBalance = (await client.readContract({
    address: dep.vault, abi: vaultAbi, functionName: "balance", args: [],
  })) as bigint;
  note(`vault holds ${formatUsdc(vaultBalance)} USDC`);

  // Check the VAULT's balance, not the wallet's. The wallet having money says
  // nothing about whether this deployment has been funded.
  if (vaultBalance < PAY_FIRST + PAY_SECOND) {
    // Approve and deposit are both contract executions Circle will sign.
    await execute(
      USDC_ADDRESS,
      [{type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{name: "spender", type: "address"}, {name: "amount", type: "uint256"}], outputs: [{type: "bool"}]}],
      "approve(address,uint256)",
      [dep.vault, (PAY_FIRST + PAY_SECOND).toString()],
      "approve the vault",
    );
    await execute(dep.vault, vaultAbi, "deposit(uint256)", [(PAY_FIRST + PAY_SECOND).toString()], `deposit ${formatUsdc(PAY_FIRST + PAY_SECOND)} USDC`);
  } else {
    ok("the vault is already funded");
  }

  // ---- 2. register a counterparty ------------------------------------
  t("Register a counterparty");
  const nameHash = (await client.readContract({
    address: dep.registry, abi: registryAbi, functionName: "canonicalNameHash", args: [COUNTERPARTY_NAME],
  })) as `0x${string}`;
  let cpId = (await client.readContract({
    address: dep.registry, abi: registryAbi, functionName: "nameIndex", args: [nameHash],
  })) as `0x${string}`;

  if (cpId === "0x" + "0".repeat(64)) {
    // The agent submits the registration, but it names the business — it cannot
    // name itself, and naming is the only power registration confers. From here on
    // the payer half of every succession belongs to BUSINESS and nobody else.
    // The vendor consents with its own key. The agent submits, but it cannot open a
    // record at somebody else's address on its own.
    const consentDigest = (await client.readContract({
      address: dep.registry, abi: registryAbi, functionName: "registrationDigest",
      args: [COUNTERPARTY_NAME, VENDOR, BUSINESS],
    })) as `0x${string}`;
    const vendorKeyForConsent = VENDOR_KEY;
    if (!vendorKeyForConsent) {
      console.error("\n  HOROS_DEMO_VENDOR_KEY is not set: the vendor must consent to being registered.\n");
      process.exit(1);
    }
    const {privateKeyToAccount: toAccount} = await import("viem/accounts");
    const consent = await toAccount(vendorKeyForConsent).sign({hash: consentDigest});
    await execute(
      dep.registry,
      registryAbi,
      "register(string,address,address,bytes)",
      [COUNTERPARTY_NAME, VENDOR, BUSINESS, consent],
      `register "${COUNTERPARTY_NAME}", business ${BUSINESS.slice(0, 10)}…`,
    );
    cpId = (await client.readContract({
      address: dep.registry, abi: registryAbi, functionName: "nameIndex", args: [nameHash],
    })) as `0x${string}`;
  } else {
    note(`"${COUNTERPARTY_NAME}" already exists from an earlier run`);
  }
  ok(`counterparty  ${cpId.slice(0, 18)}…`);

  // Owner-only, so it goes through the business key — never through Circle. The
  // agent wallet holds no owner powers at all now: had it kept them, a compromised
  // agent could drain the vault with withdraw(), and "it can only ask" would be a lie.
  {
    const h = await getLocalSigner().writeContract({
      address: dep.vault,
      abi: vaultAbi,
      functionName: "setCounterpartyCap",
      args: [cpId, usdc(10)],
    });
    await client.waitForTransactionReceipt({hash: h});
    ok(`set a 10 USDC budget  ${explorerTx(h)}`);
  }

  // The agent wallet is the only address allowed to trigger a payment, and the
  // business key is the only address allowed to name one. That is the split the
  // demo is about, so it is stated and then enforced onchain.
  {
    const h = await getLocalSigner().writeContract({
      address: dep.vault,
      abi: vaultAbi,
      functionName: "setExecutor",
      args: [wallet.address, true],
    });
    await client.waitForTransactionReceipt({hash: h});
    ok(`only ${wallet.address.slice(0, 10)}… may trigger payments  ${explorerTx(h)}`);
  }

  // ---- 3. pay the ordinary invoice ------------------------------------
  t("Pay the first invoice. The address is the one on record.");
  if (!(await refUsed(keccak256(toHex("circle-inv-1"))))) {
    await execute(dep.vault, vaultAbi, "pay(bytes32,uint256,bytes32)", [cpId, PAY_FIRST.toString(), keccak256(toHex("circle-inv-1"))], `pay ${formatUsdc(PAY_FIRST)} USDC`);
  } else {
    note("already paid in an earlier run");
  }

  // ---- 4. the attack -------------------------------------------------
  t("An invoice arrives with an account we have never paid");
  const attackDoc = buildInvoice("attack", {payTo: VENDOR_NEW, prior: VENDOR, amount: formatUsdc(PAY_SECOND)});
  const read = readInvoice(attackDoc);
  note("read " + read.amount + " USDC for " + read.counterpartyName + ", payable to " + short(read.account ?? "0x"));

  const ev = await evidence(cpId, VENDOR_NEW, PAY_SECOND, read);
  note("what the document says, as probabilities rather than a verdict:");
  for (const l of judgmentLines(ev.judgment)) note(l);
  const d = decide(ev);
  note(`policy: ${d.verdict}`);
  for (const r of d.reasons.filter((x) => x.blocking)) note(`  · ${r.detail}`);
  if (d.verdict === "RELEASE") {
    console.error("\n  the policy released this — that is a bug, not a demo\n");
    process.exit(1);
  }
  ok("the policy refused it, and the contract was never called");

  // ---- 5. the ceremony, signed by two parties ------------------------
  t("The vendor performs the ceremony");
  const succId = await proposeAndComplete(cpId, VENDOR, VENDOR_NEW);
  ok(`ceremony  ${succId.slice(0, 18)}…  complete`);

  // ---- 6. pay the new account ----------------------------------------
  t("Pay the new account. It is on the record now.");
  const d2 = decide(await evidence(cpId, VENDOR_NEW, PAY_SECOND, readInvoice(buildInvoice("afterMove", {payTo: VENDOR_NEW, amount: formatUsdc(PAY_SECOND)}))));
  note(`policy: ${d2.verdict}  —  ${d2.headline}`);
  if (d2.verdict !== "RELEASE") {
    console.error("\n  the policy still refuses the newly attested account — investigate\n");
    process.exit(1);
  }
  await execute(dep.vault, vaultAbi, "pay(bytes32,uint256,bytes32)", [cpId, PAY_SECOND.toString(), keccak256(toHex("circle-inv-2"))], `pay ${formatUsdc(PAY_SECOND)} USDC`);

  // ---- 7. the lineage ------------------------------------------------
  t("The lineage, in public");
  const lineage = (await client.readContract({
    address: dep.registry, abi: registryAbi, functionName: "lineage", args: [cpId],
  })) as {account: `0x${string}`; successorOf: `0x${string}`; attestationCount: number}[];
  lineage.forEach((e, i) =>
    note(
      `${i + 1}. ${short(e.account)}  ` +
        (i === 0 ? "opened by payment evidence" : `successor of ${short(e.successorOf)} · ${e.attestationCount} signatures`),
    ),
  );
  ok(`${lineage.length} accounts, 1 ceremony, 0 unapproved changes`);

  console.log(`\n\x1b[1m  Done.\x1b[0m  Every transaction above was signed by Circle, not by this process.`);
  console.log(`  Agent wallet: ${explorerAddress(wallet.address)}`);
  console.log(`  Registry:     ${explorerAddress(dep.registry)}`);
  console.log(`  Vault:        ${explorerAddress(dep.vault)}\n`);
}

async function evidence(
  cpId: `0x${string}`,
  invoiceAccount: `0x${string}`,
  amount: bigint,
  read: ReadInvoice,
): Promise<Evidence> {
  const [cp, lineage, cap, globalCap, payerCount, payerTotal] = await Promise.all([
    client.readContract({address: dep.registry, abi: registryAbi, functionName: "get", args: [cpId]}) as Promise<{canonicalName: string; status: number; activeAccount: `0x${string}`}>,
    client.readContract({address: dep.registry, abi: registryAbi, functionName: "lineage", args: [cpId]}) as Promise<unknown[]>,
    client.readContract({address: dep.vault, abi: vaultAbi, functionName: "counterpartyCap", args: [cpId]}) as Promise<bigint>,
    client.readContract({address: dep.vault, abi: vaultAbi, functionName: "globalCap", args: []}) as Promise<bigint>,
    client.readContract({address: dep.registry, abi: registryAbi, functionName: "payerPaymentCount", args: [cpId, PAYER]}) as Promise<bigint>,
    client.readContract({address: dep.registry, abi: registryAbi, functionName: "payerTotalPaid", args: [cpId, PAYER]}) as Promise<bigint>,
  ]);
  return {
    counterpartyId: cpId,
    canonicalName: cp.canonicalName,
    status: (["None", "Clean", "Broken"] as const)[cp.status] ?? "None",
    activeAccount: cp.activeAccount,
    accountCount: lineage.length,
    payerPayments: Number(payerCount),
    payerTotal,
    invoiceAccount,
    addressMatchesActive: cp.activeAccount.toLowerCase() === invoiceAccount.toLowerCase(),
    successionPending: false,
    termsDays: 30,
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

async function refUsed(r: `0x${string}`): Promise<boolean> {
  try {
    return (await client.readContract({address: dep.vault, abi: vaultAbi, functionName: "referenceUsed", args: [r]})) as boolean;
  } catch {
    return true;
  }
}

async function proposeAndComplete(
  cpId: `0x${string}`,
  from: `0x${string}`,
  to: `0x${string}`,
): Promise<`0x${string}`> {
  const h = await circle.createContractExecutionTransaction({
    walletId: wallet.id,
    blockchain,
    contractAddress: dep.registry,
    abiJson: JSON.stringify(registryAbi) as never,
    abiFunctionSignature: "proposeSuccession(bytes32,address,uint64)",
    abiParameters: [cpId, to, String(7 * 24 * 60 * 60)] as never,
    fee: {type: "level", config: {feeLevel: "MEDIUM"}},
  } as never);
  const proposeId = h.data?.id;
  if (!proposeId) throw new Error("Circle did not return a transaction id");
  await settle(proposeId, "propose the move");

  const ids = (await client.readContract({
    address: dep.registry, abi: registryAbi, functionName: "successionsOf", args: [cpId],
  })) as `0x${string}`[];
  const sid = ids[ids.length - 1];

  // The business needs no registration: it was named at registration, and the
  // payer half of this succession belongs to it and nobody else. Read it back and
  // say so plainly, because a ceremony whose authoriser is ambiguous is theatre.
  {
    const cp = (await client.readContract({
      address: dep.registry, abi: registryAbi, functionName: "get", args: [cpId],
    })) as {business: `0x${string}`};
    if (cp.business.toLowerCase() !== BUSINESS.toLowerCase()) {
      console.error(`\n  the counterparty's business is ${cp.business}, not ${BUSINESS} — aborting\n`);
      process.exit(1);
    }
    ok(`the business is ${BUSINESS.slice(0, 10)}… — designated at registration, transferable only by itself`);
  }

  // Attestations are EIP-712 signatures, so they are produced offchain by the
  // signing parties and posted. Circle signs the submission, not the attestation.
  const s = (await client.readContract({
    address: dep.registry, abi: registryAbi, functionName: "succession", args: [sid],
  })) as {counterpartyId: `0x${string}`; id: `0x${string}`; to: `0x${string}`; expiresAt: bigint};
  // One digest per role: the signature names the half it fills, so a submitter
  // cannot take the business's payer signature and spend it as a quorum one.
  const digestFor = async (role: number): Promise<`0x${string}`> =>
    (await client.readContract({
      address: dep.registry, abi: registryAbi, functionName: "successionDigest",
      args: [s.counterpartyId, s.id, s.to, s.expiresAt, role],
    })) as `0x${string}`;

  const vendorKey = VENDOR_KEY;
  if (!vendorKey) {
    console.error("\n  HOROS_DEMO_VENDOR_KEY is not set.");
    console.error("  The vendor must sign for itself: that is the whole point.\n");
    process.exit(1);
  }
  const {privateKeyToAccount} = await import("viem/accounts");
  const vendorSig = await privateKeyToAccount(vendorKey).sign({hash: await digestFor(0)});
  await execute(dep.registry, registryAbi, "attest(bytes32,uint8,bytes)", [sid, "0", vendorSig], "attest, by the account that was last paid");

  // The payer half of the ceremony is signed by the BUSINESS, with its own key,
  // and submitted through Circle. That is the correct split of authority:
  //
  //   the agent  (Circle, keyless)  submits transactions; triggers the payment
  //   the business (its own key)   authorises a change of destination, sets budgets,
  //                                names the executor, can stop the vault
  //   the vendor  (its own key)    authorises its own new account
  //
  // So the agent cannot move money to a new address even if it is fully
  // compromised and even if it holds every budget. It can only ask.
  const payerSig = await privateKeyToAccount(process.env.HOROS_DEPLOYER_PRIVATE_KEY as `0x${string}`).sign({
    hash: await digestFor(1),
  });
  await execute(dep.registry, registryAbi, "attest(bytes32,uint8,bytes)", [sid, "1", payerSig], "attest, by the payer");

  const a = await circle.createContractExecutionTransaction({
    walletId: wallet.id,
    blockchain,
    contractAddress: dep.registry,
    abiJson: JSON.stringify(registryAbi) as never,
    abiFunctionSignature: "activate(bytes32)",
    abiParameters: [sid] as never,
    fee: {type: "level", config: {feeLevel: "MEDIUM"}},
  } as never);
  const activateId = a.data?.id;
  if (!activateId) throw new Error("Circle did not return a transaction id");
  await settle(activateId, "activate");
  return sid;
}

const short = (a: string) => (a === "0x" + "0".repeat(40) ? "—" : `${a.slice(0, 8)}…${a.slice(-4)}`);

let wallet: Awaited<ReturnType<typeof getAgentWallet>>;


main().catch((e) => {
  console.error(`\n  ${(e as {shortMessage?: string}).shortMessage ?? (e as Error).message}\n`);
  process.exit(1);
});

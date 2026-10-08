/**
 * Circle developer-controlled wallets.
 *
 * The agent never holds a private key here. Circle holds it, derives it from the
 * entity secret, and signs on our behalf through createContractExecutionTransaction.
 * That is what makes "the agent cannot talk its way past the contract" a real
 * property rather than a policy statement: there is no key in this process to
 * prompt, and Circle's custody layer is the only signer on Arc.
 *
 * Verified 2026-09-30 against api.circle.com with a TEST_API_KEY:
 *   - two LIVE developer-controlled wallets exist on ARC-TESTNET
 *   - the entity secret is well formed (64 lowercase alphanumeric)
 * See scripts/check-circle.ts for the live re-check.
 */

import {initiateDeveloperControlledWalletsClient} from "@circle-fin/developer-controlled-wallets";
import {getChain, currentNetwork, type NetworkKey} from "./chain";

export type CircleWallet = {
  id: string;
  address: `0x${string}`;
  blockchain: string;
  accountType?: string;
  custodyType?: string;
  state?: string;
};

let cached: CircleWallet | null = null;

export function circleClient() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new Error(
      "CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must be set. " +
        "The Circle SDK is hardcoded to https://api.circle.com, so a TEST_API_KEY is required here; " +
        "a SAND_API_KEY only works against api-sandbox.circle.com.",
    );
  }
  return initiateDeveloperControlledWalletsClient({apiKey, entitySecret});
}

/** Arc identifier as Circle spells it. */
export function circleBlockchain(key: NetworkKey = currentNetwork()): "ARC-TESTNET" | "ARC" {
  return key === "arc-mainnet" ? "ARC" : "ARC-TESTNET";
}

export async function getAgentWallet(id?: string, force = false): Promise<CircleWallet> {
  if (cached && !force && !id) return cached;
  const walletId = id ?? process.env.CIRCLE_WALLET_ID;
  if (!walletId) throw new Error("CIRCLE_WALLET_ID is not set.");
  const res = await circleClient().getWallet({id: walletId});
  // The SDK's Wallet type lags the API: it omits blockchain, custodyType and
  // state, which are all present on the wire. Read them through a narrow cast
  // rather than pretending they are not there.
  const w = res.data?.wallet as unknown as {
    id: string;
    address: `0x${string}`;
    blockchain?: string;
    accountType?: string;
    custodyType?: string;
    state?: string;
  } | undefined;
  if (!w) throw new Error(`Circle returned no wallet for id ${walletId}`);
  cached = {
    id: w.id,
    address: w.address,
    blockchain: w.blockchain ?? "",
    accountType: w.accountType,
    custodyType: w.custodyType,
    state: w.state,
  };
  return cached;
}

/**
 * Create a wallet set + wallet on Arc. Used once at bootstrap; the wallet id is
 * then pinned in .env so the agent's identity is stable across deploys.
 */
export async function bootstrapWallet(description = "Horos Agent Wallet"): Promise<CircleWallet> {
  const blockchain = circleBlockchain();
  const c = circleClient();

  const walletSet = await c.createWalletSet({description: `${description} Set`} as never);
  const walletSetId = walletSet.data?.walletSet?.id;
  if (!walletSetId) throw new Error("Circle did not return a wallet set id");

  const created = await c.createWallets({
    accountType: "EOA",
    blockchains: [blockchain],
    walletSetId,
  } as never);
  const w = created.data?.wallets?.[0];
  if (!w) throw new Error("Circle did not return a wallet");

  const out: CircleWallet = {
    id: w.id,
    address: w.address as `0x${string}`,
    blockchain,
    accountType: (w as unknown as {accountType?: string}).accountType,
    custodyType: (w as unknown as {custodyType?: string}).custodyType,
  };
  console.log(`\n  Circle wallet  ${out.address}`);
  console.log(`  wallet id      ${out.id}`);
  console.log(`  wallet set     ${walletSetId}`);
  console.log(`  blockchain     ${blockchain}  (chain ${getChain().name}, id ${getChain().id})`);
  console.log(`  custody        ${out.custodyType} — the key never leaves Circle\n`);
  return out;
}

/** USDC held by a Circle wallet, from the chain rather than from a cached API read. */
export async function walletBalance(address: `0x${string}`): Promise<bigint> {
  const {createPublicClient, http} = await import("viem");
  const {getRpcUrls} = await import("./chain");
  const client = createPublicClient({
    chain: getChain(),
    transport: http(getRpcUrls()[0]),
  });
  return (await client.readContract({
    address: "0x3600000000000000000000000000000000000000",
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{name: "account", type: "address"}],
        outputs: [{type: "uint256"}],
      },
    ],
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
}

/**
 * Wait for a Circle transaction to settle.
 *
 * The terminal success state is COMPLETE, not CONFIRMED — CONFIRMED means the
 * transaction is mined but not yet finalised, and polling for it makes a working
 * integration look broken.
 *
 * Returns the hash rather than calling process.exit, so this is usable from
 * anything that is not a top-level script. The demo scripts decide how loud they
 * want to be about a failure; this only reports it.
 */
/**
 * Terminal success is COMPLETE. CONFIRMED is not terminal.
 *
 * The old set included both, which contradicted the comment directly above it and
 * meant a caller could read chain state and submit the next step of a ceremony
 * against a transaction that was mined but not yet finalised. On a reorg the next
 * step runs against a state that no longer exists.
 */
const SETTLED = new Set(["COMPLETE"]);
const PENDING = new Set(["QUEUED", "SENT", "CLEARED", "CONFIRMED"]);
const FAILED = new Set(["FAILED", "DENIED", "CANCELLED"]);

export type SettleResult =
  | {ok: true; state: string; txHash?: `0x${string}`}
  | {ok: false; state: string; reason: string};

/** True while a transaction is still on its way to a terminal state. */
export function isPending(state: string): boolean {
  return PENDING.has(state);
}

export async function settleCircleTransaction(
  client: ReturnType<typeof circleClient>,
  transactionId: string,
  opts: {timeoutMs?: number; onState?: (state: string) => void} = {},
): Promise<SettleResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  let lastState = "";

  while (Date.now() < deadline) {
    const r = await client.getTransaction({id: transactionId});
    const tx = r.data?.transaction;
    const state = tx?.state ?? "unknown";
    if (state !== lastState) {
      opts.onState?.(state);
      lastState = state;
    }
    if (SETTLED.has(state)) {
      return {ok: true, state, txHash: (tx as {txHash?: `0x${string}`}).txHash};
    }
    if (FAILED.has(state)) {
      const reason = (tx as unknown as {error?: {message?: string}})?.error?.message ?? "";
      return {ok: false, state, reason};
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return {ok: false, state: lastState, reason: "timed out waiting for a terminal state"};
}

/**
 * Sign and submit a contract call through Circle.
 *
 * Two details that are easy to get wrong and hard to diagnose, both found by
 * running it: `abiJson` must be a JSON *string* rather than an object, and `fee`
 * must be `{type, config:{...}}` because the SDK spreads `fee.config` into the
 * request. A bare `{feeLevel}` is silently dropped and the call is rejected for
 * want of a fee.
 *
 * The key this signs with is Circle's. The caller never holds one, which is the
 * whole point of the agent wallet and the reason the agent cannot redirect a
 * payment even when it is fully compromised.
 */
export async function circleExecute(
  client: ReturnType<typeof circleClient>,
  args: {
    walletId: string;
    blockchain: string;
    contractAddress: `0x${string}`;
    abi: unknown;
    abiFunctionSignature: string;
    abiParameters: unknown[];
  },
): Promise<string> {
  const res = await client.createContractExecutionTransaction({
    walletId: args.walletId,
    blockchain: args.blockchain,
    contractAddress: args.contractAddress,
    abiJson: JSON.stringify(args.abi) as never,
    abiFunctionSignature: args.abiFunctionSignature,
    abiParameters: args.abiParameters as never,
    fee: {type: "level", config: {feeLevel: "MEDIUM"}},
  } as never);
  const id = res.data?.id;
  if (!id) throw new Error("Circle did not return a transaction id");
  return id;
}

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

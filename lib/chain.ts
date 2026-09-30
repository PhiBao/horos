/**
 * Arc chain configuration and RPC failover.
 *
 * Arc's native gas token is USDC, so there is no gas-token handling anywhere in
 * this codebase. Fees are roughly $0.001 per ERC-20 transfer.
 */

import {createPublicClient, createWalletClient, fallback, http, type Chain, type PublicClient} from "viem";
import {arc, arcTestnet} from "viem/chains";
import {privateKeyToAccount} from "viem/accounts";

/** USDC on Arc, same address on mainnet and testnet. 6 decimals. */
/** Local anvil, for development and for the deterministic test suite. */
export const ANVIL_CHAIN: Chain = {
  id: 31337,
  name: "Anvil (Arc-like)",
  nativeCurrency: {name: "USDC", symbol: "USDC", decimals: 18},
  rpcUrls: {default: {http: ["http://127.0.0.1:8545"]}},
  blockExplorers: {default: {name: "Local", url: "http://127.0.0.1:8545"}},
  testnet: true,
};

export function isLocal(): boolean {
  return process.env.HOROS_RPC_URL?.includes("127.0.0.1") ?? false;
}

export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;

export const USDC_DECIMALS = 6;

export const NETWORKS = {
  "arc-testnet": {
    chain: arcTestnet,
    explorer: "https://explorer.testnet.arc.io",
    label: "Arc Testnet",
  },
  "arc-mainnet": {
    chain: arc,
    explorer: "https://explorer.arc.io",
    label: "Arc",
  },
} as const;

export type NetworkKey = keyof typeof NETWORKS;

/**
 * Four independent public endpoints. The demo does not depend on any one of
 * them being up.
 */
const RPC_FALLBACKS: Record<NetworkKey, string[]> = {
  "arc-testnet": [
    "https://rpc.testnet.arc.io",
    "https://rpc.blockdaemon.testnet.arc.io",
    "https://rpc.drpc.testnet.arc.io",
    "https://rpc.quicknode.testnet.arc.io",
  ],
  "arc-mainnet": [
    "https://rpc.mainnet.arc.io",
    "https://rpc.blockdaemon.mainnet.arc.io",
    "https://rpc.drpc.mainnet.arc.io",
    "https://rpc.quicknode.mainnet.arc.io",
  ],
};

export function getNetwork(key: NetworkKey = currentNetwork()) {
  return NETWORKS[key];
}

export function currentNetwork(): NetworkKey {
  return (process.env.HOROS_NETWORK as NetworkKey) ?? "arc-testnet";
}

export function getChain(key: NetworkKey = currentNetwork()): Chain {
  if (key === "arc-testnet" && isLocal()) return ANVIL_CHAIN;
  return NETWORKS[key].chain;
}

export function getRpcUrls(key: NetworkKey = currentNetwork()): string[] {
  const extra = process.env.HOROS_RPC_URL;
  return extra ? [extra, ...RPC_FALLBACKS[key]] : RPC_FALLBACKS[key];
}

export function getPublicClient(key: NetworkKey = currentNetwork()): PublicClient {
  if (key === "arc-testnet" && isLocal()) {
    return createPublicClient({chain: ANVIL_CHAIN, transport: http("http://127.0.0.1:8545")}) as PublicClient;
  }
  return createPublicClient({
    chain: getChain(key),
    transport: fallback(
      getRpcUrls(key).map((url) => http(url, {batch: {wait: 50}, retryCount: 3})),
      {rank: false},
    ),
  }) as PublicClient;
}

/**
 * A signing client.
 *
 * Arc's public RPCs are read-only: they reject `eth_sendTransaction`. Writing
 * needs either a funded key with a private RPC, or a Circle developer-controlled
 * wallet, where Circle holds the key and signs on our behalf through
 * `createContractExecutionTransaction`. See lib/wallet.ts.
 *
 * When HOROS_RPC_URL points at a writable endpoint, this returns a local signer.
 * Otherwise use getCircleWallet(), which is the production path and the one that
 * means the agent never holds a key.
 */
export function getWalletClient(account: `0x${string}`, key: NetworkKey = currentNetwork()) {
  const url = writeRpcUrl(key);
  return createWalletClient({account, chain: getChain(key), transport: http(url, {retryCount: 2})});
}

/** A signing client backed by a local key. Dev and demo only. */
export function getLocalSigner(key: NetworkKey = currentNetwork()) {
  const url = writeRpcUrl(key);
  const account = privateKeyToAccount(
    (process.env.HOROS_DEPLOYER_PRIVATE_KEY as `0x${string}`) ?? ("0x" as `0x${string}`),
  );
  return createWalletClient({account, chain: getChain(key), transport: http(url, {retryCount: 2})});
}

function writeRpcUrl(key: NetworkKey): string {
  const url = process.env.HOROS_RPC_URL;
  if (url) return url;
  throw new Error(
    `No writable RPC configured. Arc's public RPCs reject eth_sendTransaction.\n` +
      `Either set HOROS_RPC_URL (testnet node, or http://127.0.0.1:8545 for anvil), or\n` +
      `use getCircleWallet() from lib/wallet.ts, which signs through Circle's\n` +
      `developer-controlled wallets and never exposes a private key.`,
  );
}

export function explorerTx(hash: `0x${string}`, key: NetworkKey = currentNetwork()): string {
  if (key === "arc-testnet" && isLocal()) return `local:${hash}`;
  return `${NETWORKS[key].explorer}/tx/${hash}`;
}

export function explorerAddress(address: string, key: NetworkKey = currentNetwork()): string {
  if (key === "arc-testnet" && isLocal()) return `local:${address}`;
  return `${NETWORKS[key].explorer}/address/${address}`;
}

/** USDC has 6 decimals on Arc even though gas accounting uses 18. */
export function formatUsdc(amount: bigint): string {
  const whole = amount / 10n ** BigInt(USDC_DECIMALS);
  const frac = (amount % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function parseUsdc(value: string): bigint {
  const [w = "0", f = ""] = value.trim().split(".");
  return BigInt(w) * 10n ** BigInt(USDC_DECIMALS) + BigInt((f || "0").padEnd(USDC_DECIMALS, "0") || "0");
}


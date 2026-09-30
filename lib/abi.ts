/**
 * Contract ABIs and deployed addresses.
 *
 * Addresses are environment-configured rather than hardcoded so the same code
 * runs against a local anvil, Arc testnet and Arc mainnet.
 */

import {readFileSync, existsSync} from "node:fs";
import {resolve} from "node:path";
import CounterpartyRegistryArtifact from "../contracts/out/CounterpartyRegistry.sol/CounterpartyRegistry.json";
import CustodyVaultArtifact from "../contracts/out/CustodyVault.sol/CustodyVault.json";

export const registryAbi = CounterpartyRegistryArtifact.abi;
export const vaultAbi = CustodyVaultArtifact.abi;

export interface Deployment {
  registry: `0x${string}`;
  vault: `0x${string}`;
  chainId: number;
  network: string;
  deployedAt: string;
  deployer: `0x${string}`;
}

/** The committed deployment record, or null before the first deploy. */
function committedDeployment(): Deployment | null {
  const p = resolve(process.cwd(), "deployment.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Deployment;
  } catch {
    return null;
  }
}

/**
 * Where the live deployment lives.
 *
 * `deployment.json` is committed on purpose: it holds contract addresses, a chain
 * id and a timestamp, all of which are public and readable on the chain. That way
 * a judge can see exactly what is deployed without running anything.
 *
 * Environment variables win, so a local anvil run can point the app elsewhere.
 * Read lazily rather than imported, because the file does not exist until the
 * first deploy - and the deploy script itself imports this module.
 */
let cached: Deployment | null = null;

export function getDeployment(): Deployment {
  if (cached) return cached;
  const raw = process.env.HOROS_DEPLOYMENT;
  if (raw) {
    cached = JSON.parse(raw) as Deployment;
    return cached;
  }
  const committed = committedDeployment();
  if (!committed) {
    throw new Error("No deployment found. Run `pnpm deploy:testnet` first.");
  }
  cached = {...committed, network: process.env.HOROS_NETWORK ?? committed.network};
  return cached;
}

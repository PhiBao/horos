/**
 * Contract ABIs and deployed addresses.
 *
 * Addresses are environment-configured rather than hardcoded so the same code
 * runs against a local anvil, Arc testnet and Arc mainnet.
 */

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

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Run scripts/deploy.ts first.`);
  return v;
}

let cached: Deployment | null = null;

export function getDeployment(): Deployment {
  if (cached) return cached;
  const raw = process.env.HOROS_DEPLOYMENT;
  if (raw) {
    cached = JSON.parse(raw) as Deployment;
    return cached;
  }
  cached = {
    registry: requireEnv("HOROS_REGISTRY") as `0x${string}`,
    vault: requireEnv("HOROS_VAULT") as `0x${string}`,
    chainId: Number(requireEnv("HOROS_CHAIN_ID")),
    network: process.env.HOROS_NETWORK ?? "arc-testnet",
    deployedAt: requireEnv("HOROS_DEPLOYED_AT"),
    deployer: requireEnv("HOROS_DEPLOYER") as `0x${string}`,
  };
  return cached;
}

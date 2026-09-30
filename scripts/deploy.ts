/**
 * Deploy CounterpartyRegistry + CustodyVault to Arc.
 *
 * Usage:
 *   pnpm deploy:testnet
 *
 * Requires HOROS_DEPLOYER_PRIVATE_KEY in the environment or .env.local.
 * Writes .env.deployed, which the app and the demo script both read.
 */

import {writeFileSync, existsSync, readFileSync} from "node:fs";
import {privateKeyToAccount} from "viem/accounts";
import {resolve} from "node:path";
import {getLocalSigner, getPublicClient, getChain, currentNetwork, formatUsdc, USDC_ADDRESS} from "../lib/chain";
import {registryAbi, vaultAbi} from "../lib/abi";
import RegistryArtifact from "../contracts/out/CounterpartyRegistry.sol/CounterpartyRegistry.json";
import VaultArtifact from "../contracts/out/CustodyVault.sol/CustodyVault.json";

loadDotEnv();

const network = currentNetwork();
const pk = process.env.HOROS_DEPLOYER_PRIVATE_KEY;
if (!pk) {
  console.error("HOROS_DEPLOYER_PRIVATE_KEY is not set.");
  process.exit(1);
}

const account = privateKeyToAccount(pk as `0x${string}`);
const chain = getChain();
const wallet = getLocalSigner();
const publicClient = getPublicClient();
if (wallet.account.address !== account.address) {
  throw new Error("deployer mismatch: HOROS_DEPLOYER_PRIVATE_KEY does not match the signing account");
}

console.log(`\n  network   ${network}  (chainId ${chain.id})`);
console.log(`  deployer  ${account.address}`);
/** USDC only exists on a real Arc deployment; anvil needs it deployed first. */
async function usdcBalance(address: `0x${string}`): Promise<bigint> {
  try {
    return (await publicClient.readContract({
      address: USDC_ADDRESS,
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
  } catch {
    return 0n;
  }
}

console.log(`  balance   ${formatUsdc(await usdcBalance(account.address))} USDC\n`);

async function deploy() {
  const registryHash = await wallet.deployContract({
    chain,
    abi: registryAbi,
    bytecode: (RegistryArtifact as {bytecode: {object: string}}).bytecode.object as `0x${string}`,
    args: [account.address],
  });
  const registryReceipt = await publicClient.waitForTransactionReceipt({hash: registryHash});
  const registry = registryReceipt.contractAddress!;
  console.log(`  CounterpartyRegistry  ${registry}`);

  const globalCap = 500_000n * 10n ** 6n;
  const vaultHash = await wallet.deployContract({
    chain,
    abi: vaultAbi,
    bytecode: (VaultArtifact as {bytecode: {object: string}}).bytecode.object as `0x${string}`,
    args: [registry, USDC_ADDRESS, account.address, globalCap],
  });
  const vaultReceipt = await publicClient.waitForTransactionReceipt({hash: vaultHash});
  const vault = vaultReceipt.contractAddress!;
  console.log(`  CustodyVault          ${vault}`);

  // Hand the vault to the agent's own wallet, so the entity that spends is the
  // entity that sets the limits. Off unless HOROS_VAULT_OWNER is set, because the
  // two demos use different signers: pnpm demo signs locally, pnpm demo:circle
  // signs through Circle, and only one of them can be the owner at a time.
  const agentWallet = process.env.HOROS_VAULT_OWNER as `0x${string}` | undefined;
  if (agentWallet && agentWallet.toLowerCase() !== account.address.toLowerCase()) {
    const xfer = await wallet.writeContract({
      chain,
      abi: vaultAbi,
      address: vault,
      functionName: "transferOwnership",
      args: [agentWallet],
    });
    await publicClient.waitForTransactionReceipt({hash: xfer});
    console.log(`  vault owner    ${agentWallet}  (the agent)`);
  }

  // The vault is the only address allowed to attribute payments, so the
  // registry's record of who paid what cannot be forged by anyone else.
  const setVaultHash = await wallet.writeContract({
    chain,
    abi: registryAbi,
    address: registry,
    functionName: "setVault",
    args: [vault],
  });
  await publicClient.waitForTransactionReceipt({hash: setVaultHash});
  console.log(`  setVault(vault)       ${setVaultHash}`);

  const deployment = {
    registry,
    vault,
    chainId: chain.id,
    network,
    deployedAt: new Date().toISOString(),
    deployer: account.address,
  };

  // deployment.json, not .env.deployed.
  //
  // Everything here is public: contract addresses, chain id, a timestamp, the
  // deployer address. All of it is readable on the chain. Committing it is the
  // point - a judge should be able to see the live deployment without running
  // anything. But naming it .env would invite every secret-scanner and every
  // future contributor to treat public config as a credential and gitignore it.
  writeFileSync(resolve(process.cwd(), "deployment.json"), JSON.stringify(deployment, null, 2) + "\n");

  const out = [
    `HOROS_DEPLOYMENT=${JSON.stringify(deployment)}`,
    `HOROS_REGISTRY=${registry}`,
    `HOROS_VAULT=${vault}`,
    `HOROS_CHAIN_ID=${chain.id}`,
    `HOROS_NETWORK=${network}`,
    `HOROS_DEPLOYED_AT=${deployment.deployedAt}`,
    `HOROS_DEPLOYER=${account.address}`,
    `NEXT_PUBLIC_HOROS_REGISTRY=${registry}`,
    `NEXT_PUBLIC_HOROS_VAULT=${vault}`,
    `NEXT_PUBLIC_HOROS_CHAIN_ID=${chain.id}`,
    `NEXT_PUBLIC_HOROS_NETWORK=${network}`,
  ].join("\n");
  writeFileSync(resolve(process.cwd(), ".env.deployed"), out + "\n");
  appendToEnvLocal(out);

  console.log(`\n  wrote deployment.json (public, committed) and .env.local (private, ignored)\n`);
  return deployment;
}

function loadDotEnv() {
  for (const f of [".env.local", ".env"]) {
    const p = resolve(process.cwd(), f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

function appendToEnvLocal(block: string) {
  const p = resolve(process.cwd(), ".env.local");
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  const kept = existing
    .split("\n")
    .filter((l) => l.trim() && !/^(HOROS_|NEXT_PUBLIC_HOROS_)/.test(l))
    .join("\n");
  writeFileSync(p, (kept ? kept + "\n\n" : "") + "# written by scripts/deploy.ts\n" + block + "\n");
}

deploy().catch((e) => {
  // viem error payloads embed the full calldata, which is megabytes. Print the useful part.
  const msg = e?.shortMessage ?? e?.message ?? String(e);
  console.error(`\n  deploy failed: ${msg}`);
  if (e?.cause?.shortMessage) console.error(`  cause: ${e.cause.shortMessage}`);
  process.exit(1);
});

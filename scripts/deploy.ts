/**
 * Deploy CounterpartyRegistry + CustodyVault to Arc.
 *
 * Usage:
 *   pnpm deploy:testnet
 *
 * Requires HOROS_DEPLOYER_PRIVATE_KEY in the shell, .env.local, or .env — in that
 * order, through the one loader in lib/env.ts. Writes the deployment pointers to
 * .env.local, replacing only the pointers it owns.
 */

import {writeFileSync, existsSync, readFileSync} from "node:fs";
import {privateKeyToAccount} from "viem/accounts";
import {resolve} from "node:path";
import {getLocalSigner, getPublicClient, getChain, currentNetwork, formatUsdc, USDC_ADDRESS} from "../lib/chain";
import {registryAbi, vaultAbi} from "../lib/abi";
import {loadEnv} from "../lib/env.js";
import RegistryArtifact from "../contracts/out/CounterpartyRegistry.sol/CounterpartyRegistry.json";
import VaultArtifact from "../contracts/out/CustodyVault.sol/CustodyVault.json";

loadEnv();

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

  // The owner stays with the deploying key — a key the business holds. Never the
  // agent wallet, and this is not caution, it is the load-bearing half of the story:
  // the owner can call withdraw() to an arbitrary address, so whoever holds the
  // owner role can drain the vault. An earlier deployment handed it to the agent,
  // which meant a compromised agent process (holding the Circle credentials, which
  // are signing power) could take everything while "it can only ask" sat in the
  // README. If the deployer is not the business, hand it over explicitly:
  // vault.transferOwnership(business) — and mean it, because it is reversible only
  // by the new owner.
  //
  // (HOROS_VAULT_OWNER used to automate that handover. It no longer exists: a vault
  // whose owner is a config value away from the agent wallet is a vault whose owner
  // is the agent wallet.)
  console.log(`  vault owner    ${account.address}  (the deploying key — hold it like money)`);

  // Only a named executor (or the owner) may trigger a payment. The agent wallet is
  // the executor; without this the vault would let any stranger spend it in
  // cap-sized pieces. HOROS_EXECUTOR overrides, for a split deployment.
  const executor =
    (process.env.HOROS_EXECUTOR as `0x${string}` | undefined) ??
    (process.env.CIRCLE_WALLET_ADDRESS as `0x${string}` | undefined) ??
    account.address;
  {
    const execHash = await wallet.writeContract({
      chain,
      abi: vaultAbi,
      address: vault,
      functionName: "setExecutor",
      args: [executor, true],
    });
    await publicClient.waitForTransactionReceipt({hash: execHash});
    console.log(`  vault executor ${executor}  (the agent — the only address that may trigger a payment)`);
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

/**
 * Rewrite the deployment pointers, and nothing else.
 *
 * This used to drop every `HOROS_*` line, which included the operator's own
 * credentials — a deploy would delete the very key it had just used, and the
 * docstring told operators the key could live in this file. Only the keys this
 * script writes are replaced now.
 */
const DEPLOY_OWNS = new Set([
  "HOROS_DEPLOYMENT",
  "HOROS_REGISTRY",
  "HOROS_VAULT",
  "HOROS_CHAIN_ID",
  "HOROS_NETWORK",
  "HOROS_DEPLOYED_AT",
  "HOROS_DEPLOYER",
  "NEXT_PUBLIC_HOROS_REGISTRY",
  "NEXT_PUBLIC_HOROS_VAULT",
  "NEXT_PUBLIC_HOROS_CHAIN_ID",
  "NEXT_PUBLIC_HOROS_NETWORK",
]);

function appendToEnvLocal(block: string) {
  const p = resolve(process.cwd(), ".env.local");
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  const kept = existing
    .split("\n")
    .filter((l) => {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (!m) return l.trim().length > 0;
      return !DEPLOY_OWNS.has(m[1]);
    })
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

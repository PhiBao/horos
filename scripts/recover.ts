/**
 * Recover testnet USDC stranded in a previous deployment's vault.
 *
 * Each deploy creates a fresh vault and the previous one keeps whatever was
 * deposited into it. On a testnet whose faucet is a captcha, that money is not
 * free, so it is worth pulling back before redeploying rather than after.
 *
 * Only the vault owner can call withdraw. The owner is always a business-held
 * local key — never the agent wallet, because an owner that the agent holds is
 * an owner a compromised agent can drain with. So this signs locally, and it
 * refuses to run against a vault owned by anything else.
 *
 *   pnpm tsx scripts/recover.ts 0x<old vault>
 */

import {formatUnits} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {getPublicClient, getLocalSigner, currentNetwork, explorerTx} from "../lib/chain.js";
import {vaultAbi} from "../lib/abi.js";

async function main(): Promise<void> {
  const vault = process.argv[2] as `0x${string}` | undefined;
  if (!vault || !/^0x[0-9a-fA-F]{40}$/.test(vault)) {
    console.error("\n  usage: pnpm tsx scripts/recover.ts 0x<vault address>\n");
    process.exit(1);
  }

  const key = process.env.HOROS_DEPLOYER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!key) {
    console.error("\n  HOROS_DEPLOYER_PRIVATE_KEY is not set. Recovery signs with the business key.\n");
    process.exit(1);
  }
  const business = privateKeyToAccount(key);

  const client = getPublicClient();
  const wallet = getLocalSigner();

  const balance = (await client.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: "balance",
  })) as bigint;

  console.log(`\n  vault     ${vault}`);
  console.log(`  network   ${currentNetwork()}`);
  console.log(`  holds     ${formatUnits(balance, 6)} USDC`);

  if (balance === 0n) {
    console.log("\n  Nothing to recover.\n");
    return;
  }

  const owner = (await client.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: "owner",
  })) as `0x${string}`;

  console.log(`  owner     ${owner}`);
  console.log(`  business  ${business.address}`);

  if (owner.toLowerCase() !== business.address.toLowerCase()) {
    console.error(
      `\n  The vault's owner is ${owner}, not this business key.\n` +
        `  Only the owner can call withdraw, so this script cannot move it.\n` +
        `  (If the owner is an agent wallet, that deployment predates the rule that\n` +
        `  the agent must never hold owner powers. Withdraw it with that wallet's\n` +
        `  own signing path instead.)\n`,
    );
    process.exit(1);
  }

  const hash = await wallet.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: "withdraw",
    args: [business.address, balance],
  });
  await client.waitForTransactionReceipt({hash});
  console.log(`    withdrawn  ${explorerTx(hash)}`);

  const after = (await client.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: "balance",
  })) as bigint;

  console.log(`\n  vault now holds ${formatUnits(after, 6)} USDC`);
  console.log(`  the money is now in ${business.address}\n`);
}

main();

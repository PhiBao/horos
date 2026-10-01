/**
 * Recover testnet USDC stranded in a previous deployment's vault.
 *
 * Each deploy creates a fresh vault and the previous one keeps whatever was
 * deposited into it. On a testnet whose faucet is a captcha, that money is not
 * free, so it is worth pulling back before redeploying rather than after.
 *
 * The vault's owner is the only account that can call withdraw, so this signs
 * through Circle's developer-controlled wallets when the owner is the agent wallet.
 *
 *   pnpm tsx scripts/recover.ts 0x<old vault>
 */

import {formatUnits} from "viem";

import {circleClient, circleExecute, getAgentWallet, settleCircleTransaction} from "../lib/circle.js";
import {getPublicClient, currentNetwork, explorerTx} from "../lib/chain.js";
import {vaultAbi} from "../lib/abi.js";

async function main(): Promise<void> {
  const vault = process.argv[2] as `0x${string}` | undefined;
  if (!vault || !/^0x[0-9a-fA-F]{40}$/.test(vault)) {
    console.error("\n  usage: pnpm tsx scripts/recover.ts 0x<vault address>\n");
    process.exit(1);
  }

  const client = getPublicClient();
  const wallet = await getAgentWallet();
  const circle = circleClient();

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
  console.log(`  agent     ${wallet.address}`);

  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error(
      `\n  The vault's owner is ${owner}, not the Circle agent wallet.\n` +
        `  Only the owner can call withdraw, so this script cannot move it.\n`,
    );
    process.exit(1);
  }

  // Circle signs this, so the agent never handles the key even for a recovery.
  const id = await circleExecute(circle, {
    walletId: wallet.id,
    blockchain: "ARC-TESTNET",
    contractAddress: vault,
    abi: vaultAbi,
    abiFunctionSignature: "withdraw(address,uint256)",
    abiParameters: [wallet.address, balance.toString()],
  });

  const result = await settleCircleTransaction(circle, id, {
    onState: (state) => console.log(`    Circle: ${state}`),
  });
  if (!result.ok) {
    console.error(`\n  withdraw failed: ${result.state}${result.reason ? ` — ${result.reason}` : ""}\n`);
    process.exit(1);
  }
  console.log(`    withdrawn  ${result.txHash ? explorerTx(result.txHash) : id}`);

  const after = (await client.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: "balance",
  })) as bigint;

  console.log(`\n  vault now holds ${formatUnits(after, 6)} USDC`);
  console.log(`  the money is now in ${wallet.address}\n`);
}

main();

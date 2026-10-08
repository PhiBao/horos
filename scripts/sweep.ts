/**
 * Sweep everything back out.
 *
 * A deployment holds funds in two places: the vault, and the wallet that funded
 * it. Withdrawing from the vault returns the money to the owner's wallet, and then
 * one transfer sends the whole balance wherever it should end up. Two steps because
 * the contract only knows how to pay the owner.
 *
 *   pnpm sweep 0x<destination> 0x<vault> [0x<vault> ...]
 *
 * The vaults are named explicitly rather than discovered: enumerating "vaults this
 * key owns" means reading every deployment record on the machine and guessing, and
 * a recovery script that guesses is one that moves the wrong money or leaves some
 * behind. Naming them is a copy-paste from `deployments/`, and the script refuses a
 * vault whose owner is not the configured key.
 *
 * Reserves a small gas float. On Arc USDC is the gas token, so a transfer that
 * sends the entire balance leaves nothing to pay for itself.
 */

import {formatUnits} from "viem";
import {privateKeyToAccount} from "viem/accounts";

import {loadEnv} from "../lib/env.js";
import {getPublicClient, getLocalSigner, currentNetwork, explorerTx, formatUsdc} from "../lib/chain.js";
import {vaultAbi} from "../lib/abi.js";

/** Left behind so the final transfer can pay for itself. */
const GAS_FLOAT = 5_000n; // 0.005 USDC at six decimals

loadEnv();

async function main(): Promise<void> {
  const [to, ...vaults] = process.argv.slice(2);
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    console.error("\n  usage: pnpm sweep 0x<destination> [0x<vault> ...]\n");
    process.exit(1);
  }
  for (const v of vaults) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
      console.error(`\n  not an address: ${v}\n`);
      process.exit(1);
    }
  }

  const key = process.env.HOROS_DEPLOYER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!key) {
    console.error("\n  HOROS_DEPLOYER_PRIVATE_KEY is not set — the owner key signs this.\n");
    process.exit(1);
  }
  const account = privateKeyToAccount(key);

  const client = getPublicClient();
  const wallet = getLocalSigner();
  const usdc = await import("../lib/chain.js").then((m) => m.USDC_ADDRESS);
  const erc20 = [
    {type: "function", name: "balanceOf", stateMutability: "view", inputs: [{name: "a", type: "address"}], outputs: [{type: "uint256"}]},
    {type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{name: "to", type: "address"}, {name: "amount", type: "uint256"}], outputs: [{type: "bool"}]},
  ] as const;

  console.log(`\n  ${currentNetwork()} · owner ${account.address}`);
  console.log(`  destination ${to}\n`);

  // ---- 1. Empty each vault back to the owner ---------------------------
  for (const vault of vaults as `0x${string}`[]) {
    const [owner, balance] = await Promise.all([
      client.readContract({address: vault, abi: vaultAbi, functionName: "owner"}) as Promise<`0x${string}`>,
      client.readContract({address: vault, abi: vaultAbi, functionName: "balance"}) as Promise<bigint>,
    ]);

    if (balance === 0n) {
      console.log(`  ${vault}  empty, nothing to withdraw`);
      continue;
    }
    if (owner.toLowerCase() !== account.address.toLowerCase()) {
      console.error(
        `  ${vault}  owner is ${owner}, not this key — refusing.\n` +
          `  Only the owner can withdraw, so this script cannot move it.`,
      );
      process.exitCode = 1;
      continue;
    }

    const hash = await wallet.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "withdraw",
      args: [account.address, balance],
    });
    await client.waitForTransactionReceipt({hash});
    console.log(`  ${vault}  withdrew ${formatUsdc(balance)} USDC  ${explorerTx(hash)}`);
  }

  // ---- 2. Send the wallet balance on -----------------------------------
  const balance = (await client.readContract({address: usdc, abi: erc20, functionName: "balanceOf", args: [account.address]})) as bigint;
  if (balance <= GAS_FLOAT) {
    console.error(
      `\n  wallet holds ${formatUnits(balance, 6)} USDC, which is at or below the ` +
        `${formatUnits(GAS_FLOAT, 6)} USDC gas float. Nothing sent.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const send = balance - GAS_FLOAT;
  const hash = await wallet.writeContract({
    address: usdc,
    abi: erc20,
    functionName: "transfer",
    args: [to as `0x${string}`, send],
  });
  await client.waitForTransactionReceipt({hash});

  const after = (await client.readContract({address: usdc, abi: erc20, functionName: "balanceOf", args: [account.address]})) as bigint;

  console.log(`\n  sent        ${formatUnits(send, 6)} USDC  ${explorerTx(hash)}`);
  console.log(`  remaining   ${formatUnits(after, 6)} USDC (gas float and dust)\n`);
}

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

/**
 * Print the faucet link and current balance. The Circle faucet needs a captcha,
 * so it cannot be automated - a human clicks it once.
 *
 * Run: pnpm faucet
 */
import {getPublicClient, currentNetwork, formatUsdc, USDC_ADDRESS} from "../lib/chain.js";

const key = currentNetwork();
const addr = "0x0382bca3Fc934169a43c7ebe1Ee4B4d6A69C1e67";
const c = getPublicClient();
const bal = (await c.readContract({
  address: USDC_ADDRESS,
  abi: [{type: "function", name: "balanceOf", stateMutability: "view", inputs: [{name: "a", type: "address"}], outputs: [{type: "uint256"}]}],
  functionName: "balanceOf",
  args: [addr as `0x${string}`],
})) as bigint;

console.log(`\n  Arc ${key}`);
console.log(`  ${addr}`);
console.log(`  balance  ${formatUsdc(bal)} USDC\n`);
if (key === "arc-testnet" && bal < 20_000_000n) {
  console.log(`  Get more: https://faucet.circle.com`);
  console.log(`  Choose Arc Testnet, paste the address above. 20 USDC per claim, one claim per 2 hours.\n`);
}

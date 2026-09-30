/**
 * Verify the Arc endpoints actually work, for reads and for writes.
 * Run: pnpm check:chain
 */
import {getPublicClient, currentNetwork, USDC_ADDRESS, formatUsdc} from "../lib/chain.js";

const key = currentNetwork();
const client = getPublicClient();
const rpc = process.env[key === "arc-mainnet" ? "HOROS_RPC_URL_MAINNET" : "HOROS_RPC_URL_TESTNET"];

console.log(`\n  network  ${key}`);
console.log(`  rpc      ${(rpc ?? "public").replace(/\/[a-f0-9]{40}\//, "/<key>/")}\n`);

const chainId = await client.getChainId();
console.log(`  chainId                ${chainId}`);

const block = await client.getBlockNumber();
console.log(`  head block             ${block}`);

const gas = await client.getGasPrice();
console.log(`  gas price              ${gas} wei`);

const wallet = "0x0382bca3Fc934169a43c7ebe1Ee4B4d6A69C1e67";
const bal = (await client.readContract({
  address: USDC_ADDRESS,
  abi: [{type: "function", name: "balanceOf", stateMutability: "view", inputs: [{name: "a", type: "address"}], outputs: [{type: "uint256"}]}],
  functionName: "balanceOf",
  args: [wallet as `0x${string}`],
})) as bigint;
console.log(`  deployer USDC          ${formatUsdc(bal)}`);
console.log(`\n  reads OK\n`);

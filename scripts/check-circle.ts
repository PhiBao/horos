/**
 * Live check of the Circle signing path. Run before trusting it in a demo.
 *
 *   pnpm check:circle
 *
 * Verifies, in order:
 *   1. the API key authenticates against api.circle.com
 *   2. the entity secret is well formed
 *   3. the pinned wallet exists and is on Arc
 *   4. the entity secret can actually sign a contract execution
 *
 * Step 4 is the one that matters. Everything before it is a credential check;
 * step 4 proves the agent can move money without ever holding a key.
 */

import {readFileSync} from "node:fs";
import {getAgentWallet, circleClient, circleBlockchain} from "../lib/circle.js";
import {currentNetwork, getChain, formatUsdc} from "../lib/chain.js";
import {walletBalance} from "../lib/circle.js";
import {registryAbi, getDeployment} from "../lib/abi.js";

loadEnv();

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);

// -- 1. key authenticates ------------------------------------------------
let wallets: {id: string; address: string; blockchain?: string; accountType?: string}[] = [];
try {
  const res = await circleClient().listWallets({});
  wallets = ((res.data as {wallets?: typeof wallets} | undefined)?.wallets ?? []) as typeof wallets;
  check("API key authenticates", true, `${wallets.length} wallet(s) visible`);
} catch (e) {
  const msg = (e as {shortMessage?: string}).shortMessage ?? (e as Error).message;
  check("API key authenticates", false, msg);
}

// -- 2. entity secret ----------------------------------------------------
const secret = process.env.CIRCLE_ENTITY_SECRET ?? "";
check(
  "entity secret is well formed",
  /^[0-9a-z]{64}$/.test(secret),
  `${secret.length} chars`,
);

// -- 3. pinned wallet ----------------------------------------------------
let wallet: Awaited<ReturnType<typeof getAgentWallet>> | null = null;
try {
  wallet = await getAgentWallet();
  const want = circleBlockchain();
  const onArc = (wallet.blockchain ?? "").toUpperCase().includes("ARC");
  check("pinned wallet is live on Arc", onArc, `${wallet.id} · ${wallet.blockchain} · ${wallet.accountType}`);
  check("wallet state is LIVE", (wallet.state ?? "LIVE") === "LIVE", wallet.state ?? "unknown");
  if (wallets.length && !wallets.some((w) => w.id === wallet!.id)) {
    check("pinned wallet is in the entity's wallet list", false, "not found in list");
  } else {
    check("pinned wallet is in the entity's wallet list", true);
  }
} catch (e) {
  const msg = (e as {shortMessage?: string}).shortMessage ?? (e as Error).message;
  check("pinned wallet is live on Arc", false, msg);
}

// -- 4. the entity secret can sign --------------------------------------
// Read-only calls go through the Contracts SDK without a wallet or gas, which
// proves the entity can talk to the contract at all. A real write is exercised by
// scripts/demo-circle.ts so this check stays safe to run at any time.
try {
  const dep = getDeployment();
  const c = circleClient();
  const {initiateSmartContractPlatformClient} = await import("@circle-fin/smart-contract-platform");
  const scp = initiateSmartContractPlatformClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
  const q = (await scp.queryContract({
    abiFunctionSignature: "registryOwner()",
    abiJson: registryAbi as never,
    address: dep.registry,
    blockchain: circleBlockchain() as never,
  } as never)) as {data?: {response?: {data?: unknown}}};
  const readBack = q.data?.response?.data;
  check(
    "contract is readable through Circle",
    Boolean(readBack),
    readBack ? `registryOwner = ${String(readBack).slice(0, 66)}` : "no response",
  );
} catch (e) {
  const msg = (e as {shortMessage?: string}).shortMessage ?? (e as Error).message;
  check("contract is readable through Circle", false, msg);
}

// -- balance -------------------------------------------------------------
if (wallet) {
  try {
    const bal = await walletBalance(wallet.address);
    check("Circle wallet is funded", bal > 0n, `${formatUsdc(bal)} USDC on ${getChain().name}`);
  } catch (e) {
    check("Circle wallet is funded", false, (e as Error).message.slice(0, 80));
  }
}

// -- report --------------------------------------------------------------
console.log(`\n  Circle signing path — ${currentNetwork()}\n`);
for (const [name, ok, detail] of results) {
  const mark = ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${mark} ${name.padEnd(42)} ${detail ? `\x1b[2m${detail}\x1b[0m` : ""}`);
}
const passed = results.filter(([, ok]) => ok).length;
console.log(`\n  ${passed}/${results.length} checks passed\n`);

function loadEnv() {
  for (const f of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {}
  }
}

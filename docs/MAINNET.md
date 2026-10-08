# Running on Arc mainnet

Everything here is prepared. What it needs is USDC and a decision; the sequence
below is two commands.

## What you need

**USDC on Arc mainnet, at the address that deploys:**

```
0x0382bca3Fc934169a43c7ebe1Ee4B4d6A69C1e67
```

**Send about 3 USDC.** The breakdown, with gas measured at 20 Gwei:

| | |
|---|---|
| Deploy CounterpartyRegistry | 0.049 USDC (2,450,061 gas) |
| Deploy CustodyVault | 0.015 USDC (744,812 gas) |
| `setVault`, `setExecutor` | ~0.006 USDC |
| Fund the vault for the ceremony | 1.20 USDC (0.20 + 1.00) |
| Ceremony gas | ~0.01 USDC |
| **Total** | **~1.3 USDC** |

Three rather than 1.3 because a redeploy costs the deploy portion again, and having
one clean retry available is worth more than 1.7 USDC of idle balance.

Routes onto Arc mainnet, since there is no faucet for real money: **CCTP** from any
supported chain (Base is the usual one) to the same address; **Circle Mint** if you
have a business account; or swap on an Arc DEX, since Uniswap and Aerodrome are live
there. The community bridge at `bridge.arcexplorer.org` is a front-end for Circle
Gateway and charges 2.5%; going to CCTP directly avoids that.

## The custody trade, stated plainly

**A Circle production key is not required to be live on mainnet.** It is required
only for the *keyless* signing path — Circle holding the key and submitting
transactions over HTTPS. Nothing else on mainnet touches the Circle SDK: not the
deployment, not the vault, not the ceremony, and not the site, which reads the chain
directly.

So the two deployments differ in who signs:

| | Testnet | Mainnet |
|---|---|---|
| Who signs | Circle custody, over HTTPS | A local key |
| Agent holds a key | **no** | **yes** |
| If the agent process is compromised | it cannot sign anything | it can sign what the contract allows |
| Contracts, policy, ceremony, refusal | identical | identical |

This is a real difference and it is not hidden. The claim **"a fully compromised
agent cannot authorise a change of destination"** holds on both chains, because it
is a property of the contracts — `pay()` takes no address, and the payer half needs
the business key. What changes is the claim *"the agent cannot talk its way past
this"*: on testnet that is structural, on mainnet it is a matter of the agent
behaving, bounded by three things that are still enforced onchain:

- **`globalCap`** — the ceiling on any single payment, and on mainnet it must be
  stated explicitly. The deploy refuses without `HOROS_GLOBAL_CAP`, because the
  testnet default is 500,000 USDC.
- **`counterpartyCap`** — a per-vendor ceiling, set separately.
- **The executor allowlist** — only the named executor or the owner can trigger a
  payment at all.

On mainnet the deploying key also holds the owner role, the executor role, and the
business role for the demo counterparty, because the total at risk is a few dollars
and splitting the roles needs custody this deployment does not have. **A production
deployment must split them**, and the owner key in particular should be custody-held
or on a hardware wallet: the owner can call `withdraw()` to any address.

## The run

```bash
# 1. Deploy. Refuses without an explicit global cap.
HOROS_GLOBAL_CAP=2 pnpm deploy:mainnet

# 2. Point the mainnet site at it, and deploy the second Worker.
pnpm sync:site:mainnet
pnpm site:deploy:mainnet
pnpm wrangler secret put JUDGMENT_API_KEY --config wrangler.mainnet.jsonc
```

Then the ceremony, at demonstration amounts rather than testnet's:

```bash
HOROS_DEMO_CAP=2 HOROS_DEMO_PAY_FIRST=0.2 HOROS_DEMO_PAY_SECOND=1.0 pnpm demo
```

`pnpm demo` signs locally, which is what mainnet uses. `pnpm demo:circle` will fail
on mainnet — a test API key is refused for `ARC` with a 400, which is verified in
`docs/AUDIT-2026-10-08.md`.

## Which network is which

Both chains are readable from either URL. The chain picker in the header switches
between them, the choice travels as `?network=`, and the custody line beside the
picker changes with it. The two Worker URLs exist only so that a link can default to
the chain it means:

| | Testnet | Mainnet |
|---|---|---|
| Default chain | `arc-testnet` | `arc-mainnet` |
| Worker | `horos` | `horos-mainnet` |
| Config | `wrangler.jsonc` | `wrangler.mainnet.jsonc` |
| Addresses | `deployments/arc-testnet.json` | `deployments/arc-mainnet.json` |
| Writable RPC | `HOROS_RPC_URL_TESTNET` | `HOROS_RPC_URL_MAINNET` |

The two config files are written by one command, `pnpm sync:site`, and differ by
exactly one variable — the default chain. Everything else is derived from
`HOROS_DEPLOYMENTS`, a single JSON map written from `deployments/*.json`. Writing one
network at a time is how the two configs drifted apart in the first place: the site
was once pointed at a stale deployment for hours because a second deploy was never
followed by a second sync, and only the screen recording caught it.

`GET /api/networks` publishes the map to the interface, which is why the picker needs
no hardcoded list and the "Load our verified record" button can point at each chain's
own counterparty. The id is `keccak(name, first account, registry)` and changes on
every deploy, so the demo records its id into `deployments/<network>.json` when it
runs and the site reads it from there.

A deploy to the wrong chain is refused rather than performed: if the network is
mainnet and the writable RPC URL mentions testnet (or the reverse), the write path
throws before it sends anything. An unknown `HOROS_NETWORK` throws too, because a
site that reads testnet while its configuration says mainnet shows numbers that look
real and are not.

## After a run

The vaults were swept back to the owner once the ceremony was recorded, so the
mainnet site now reports a vault balance of zero. That is honest and it changes
nothing about the record: the ceremony, the two signatures and both payments are
transactions and they stay on the explorer. A vault with no funds simply cannot pay,
which is the correct state for a read-only demonstration.

```bash
pnpm sweep 0x<destination> 0x<vault> [0x<vault> ...]
```

That withdraws from each vault (owner-only, and it refuses a vault whose owner is
not the configured key), then sends the wallet balance on. It keeps a small gas
float, because on Arc USDC is the gas token and a transfer that sends everything
leaves nothing to pay for itself.

## If something is wrong

The vault owner can withdraw the whole balance at any time:

```bash
pnpm tsx scripts/recover.ts 0x<vault>
```

That signs locally, which is the correct path on mainnet, and it refuses a vault
whose owner is not the configured business key. Nothing here is upgradeable: a bug
means deploying again and migrating, which is why the caps exist and why the first
mainnet deployment should hold only what you are willing to lose.

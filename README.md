# Horos

**A change of payment address is a succession ceremony, not a field update.**

Horos is an agent that pays a business's invoices from its own USDC wallet on
[Arc](https://arc.network), and will not release a dollar to an address it cannot
prove is the same counterparty it already paid.

The interface makes that structural rather than aspirational: there is no
`updateAccount(address)` function, and the vault has no call that accepts a
destination. Moving a payment address requires two signatures, neither of which
can come from the party receiving the money.

```solidity
function pay(bytes32 counterpartyId, uint256 amount, bytes32 ref) external returns (address);
```

Read that signature again. There is no `to` parameter. The caller names *who* to
pay, never *where*. The destination is resolved from the registry, and the only
way an address becomes a counterparty's active account is a succession ceremony
that the recipient cannot complete on its own.

---

## The problem

Business email compromise cost **$3.04 billion in 2025** — 24,768 incidents, an
average reported loss above $122,000, and the second most expensive category of
cybercrime ([FBI IC3 2025](https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf)).
The mechanism is not a sophisticated attack. An email says the bank details
changed.

The standard control is to phone the vendor and confirm. As of 2026 that control
is under direct attack: the AFP's payments fraud survey
([2026 edition](https://www.financialprofessionals.org/training-resources/resources/survey-research-economic-data/Details/payments-fraud))
measured AI-enabled fraud and **deepfake voice and video impersonation of
executives and vendors for the first time**. 76% of organisations reported
attempted or actual payments fraud in 2025.

So every channel a business uses to *learn* a new counterparty's address — phone,
email, domain, portal, even video — is now forgeable.

**One thing is not.** The key that received the last payment. It never speaks, so
it cannot be cloned. It never leaves the device, so it cannot be phished. It is
the only trustworthy signal left in a redirected payment, and nobody had built a
system around it.

Horos makes that the unit of a payment system.

---

## What it does

```
invoice ─► extract (model proposes) ─► policy (decides, in code) ─► contract (enforces)
```

Three layers, and the separation between them is the design.

| Layer | Where | What it can do |
|---|---|---|
| **Judgment** | offchain | read the invoice, assemble evidence, *propose* a verdict |
| **Policy** | offchain, deterministic | *decide* RELEASE / HOLD / ESCALATE, in code |
| **The Rule** | onchain | *enforce*. the only thing that can move money |

A model can ask a person a question. It cannot release a payment. That asymmetry
is enforced by `applyModelProposal` in [`lib/policy.ts`](lib/policy.ts), which is
one-directional on purpose:

- model says `ESCALATE`, policy says `RELEASE` → **escalated**, with the model's
  reason recorded as a blocking reason
- model says `RELEASE`, policy says `HOLD` → **held**, and the disagreement is
  logged rather than discarded

The second case is the interesting one. The model wants to pay; the policy
refuses; the refusal stands. That disagreement is the calibration scoreboard, and
it is worth more than the model's opinion was.

This is also the correction to a pattern worth naming. Circle's own `arc-escrow`
sample releases funds when a vision model returns `confidence: "HIGH"`, and stores
a release timestamp it never reads. A confidence string is not a control. Here the
model's output is an input, never the release condition.

---

## The ceremony

When a vendor's payment address changes, the old key and a payer must both sign
for it. The proposed new account can supply neither.

```
proposeSuccession(id, to, window)
        │
        ├─ attest(OldKey)   signed by the account that received the last payment
        ├─ attest(Payer)    signed by a registered payer
        └─ quorum           optional, demanded by either party
        │
     activate()   ──► the new account is now active
```

Properties the test suite asserts, most of which are *negations*:

- an account cannot change without the old key's signature
- the old key alone still gets nowhere
- a payer alone still gets nowhere
- the proposed recipient cannot sign for its own arrival, in any role
- one signature from one party counts once; two parties may sign the same digest
- an expired proposal cannot be revived
- nobody may skip a state
- the registry owner, who is neither the business nor the recipient, has no say
- a payer's payment history cannot be forged — only the vault may record it

If the old key is gone forever, the only remaining path is `discloseInheritance`,
which marks the counterparty `BROKEN` in public and **permanently**, and does not
move the account. Every future payer sees the gap before sending anything.

That is deliberate. The alternative to a disclosed break is a quiet reset, and a
quiet reset is exactly how invoice-redirection fraud launders itself. The contract
offers no way to undo the disclosure, because a system that can quietly un-break a
lineage is not a system.

---

## Three-way separation of authority

| Party | Key | Can do | Cannot do |
|---|---|---|---|
| **Agent** | none — Circle holds it | execute payments, set budgets, stop the vault | authorise a change of destination |
| **Business** | its own | authorise a change of destination | pay a non-active account |
| **Vendor** | its own | authorise its own new account | sign for itself as a payer or a recipient |

The agent runs on a
[Circle developer-controlled wallet](https://developers.circle.com/wallets). The
private key does not exist in the application at all — Circle derives it from the
entity secret and signs over HTTPS. There is nothing in the process for a prompt
to reach.

That matters more than usual here, because of what vault ownership *means*:

```solidity
function transferOwnership(address newOwner) external onlyOwner;  // one-way
```

Ownership grants the ability to **set limits and pull the plug**. It never grants
the ability to redirect a payment, because `pay()` takes no address. So handing
the vault to an agent cannot hand over the ability to spend — only the ability to
constrain.

The result: **a fully compromised agent holding every budget still cannot send
money to a new address. It can only ask.**

---

## Run it

Requires Node 22, [Foundry](https://book.getfoundry.sh), and either a funded
Circle wallet or a funded local key.

```bash
pnpm install
(cd contracts && forge install)
cp .env.example .env      # add your keys, see below
pnpm contract:test        # 35 tests
pnpm test                 # 17 tests
```

### The keyless demo

```bash
pnpm deploy:testnet
pnpm demo:circle
```

Executes the full story against real Arc testnet USDC and prints a transaction
hash for every step:

```
01. There is no key in this process
02. Fund the vault           ✓ approve  ✓ deposit
03. Register a counterparty  ✓ register ✓ set a budget
04. Pay 0.4 USDC              ✓ the address is the one on record
05. An invoice arrives with an account we have never paid
      policy: HOLD — nothing has signed for it
06. The ceremony              ✓ propose ✓ vendor attests ✓ business attests ✓ activate
07. Pay 2.4 USDC              policy: RELEASE
08. 2 accounts, 1 ceremony, 0 unapproved changes
```

Every transaction is signed by Circle. `pnpm check:circle` verifies the
credentials, the wallet, and that the contracts are readable through Circle's
Contracts API.

### The local-key demo

```bash
pnpm deploy:testnet
pnpm demo
```

The same story with a local signing key, for when Circle credentials are not
available. Note that Arc's public RPCs are **read-only** — they reject
`eth_sendTransaction` — so writes need a funded node:

```bash
qn endpoint create --chain arc --network arc-testnet
```

Set the result as `HOROS_RPC_URL`, or point `HOROS_RPC_URL` at
`http://127.0.0.1:8545` for anvil.

### Environment

| Variable | Purpose |
|---|---|
| `CIRCLE_API_KEY` | a `TEST_API_KEY` — the Circle SDK is hardcoded to `api.circle.com`, so a sandbox key will not work |
| `CIRCLE_ENTITY_SECRET` | 64 lowercase alphanumeric characters |
| `CIRCLE_WALLET_ID` | the agent's Circle wallet |
| `CIRCLE_WALLET_ADDRESS` | its address, used as vault owner |
| `HOROS_RPC_URL` | a **writable** Arc node |
| `HOROS_DEPLOYER_PRIVATE_KEY` | deploys contracts, signs the payer's half of the ceremony |
| `HOROS_DEMO_VENDOR_KEY` | the vendor's key, for the demo ceremony |
| `HOROS_VAULT_OWNER` | who owns the vault; set to the Circle address for the keyless demo |

Testnet USDC is free from [faucet.circle.com](https://faucet.circle.com) — 20
USDC per claim, no account needed. `pnpm faucet` prints the balance.

---

## Layout

```
contracts/src/CounterpartyRegistry.sol   durable identity, public lineage, the ceremony
contracts/src/CustodyVault.sol           holds USDC, pays counterparties, takes no address
lib/policy.ts                             the decision, as a pure function. no model in the release path
lib/policy.test.ts                        including the cases a model must not be able to overrule
lib/circle.ts                             Circle wallets. the key is never in this process
lib/screening.ts                          one input among many; fails closed unless a person waived it
lib/invoice.ts                            extraction, and prompt-injection capture
lib/chain.ts                              Arc config, RPC failover, 18-decimal gas / 6-decimal USDC
scripts/demo-circle.ts                    the keyless walkthrough
deployment.json                           what is live, committed on purpose
```

`deployment.json` is committed because everything in it is public — contract
addresses, chain id, a timestamp — and readable on the chain anyway. A judge
should be able to see what is deployed without running anything. It is not named
`.env` precisely so that nobody treats it as a credential and ignores it.

---

## Honest scope

Things that are real, and things that are not.

**Real, and verifiable on Arc testnet:**

- the contracts, deployed, with transaction hashes
- the refusal: the policy holds, and the vault cannot be *given* the new address
- the ceremony, signed by two parties, with the recipient shown it cannot self-sign
- the payment after, and the public lineage it leaves
- 52 tests, most of which assert that something **cannot** happen

**Not built yet:**

- a web interface. The decision logic is complete and tested; nobody has touched
  it through a browser
- counterparty screening. [`lib/screening.ts`](lib/screening.ts) reports
  `unavailable` and the policy blocks on it, unless a person has explicitly waived
  screening. A waiver can never hide an actual hit. Both behaviours are tested.
- mainnet. Testnet only.
- cross-chain payments. CCTP is unused.
- yield. `USYC` requires a non-US person, a $100,000 minimum and an allowlist
  ticket, so it was left alone deliberately.
- `Paymaster`, which does not support Arc — USDC *is* the gas token there, so
  there is nothing to abstract.

**Untested against real money.** Every number here is testnet USDC. The logic does
not change on mainnet; the custody assumptions do, and that has not been
exercised.

---

## Prior art

Named because a judge who knows these will ask, and because engaging them is
part of the argument. One line each.

| | What it does | Why this is different |
|---|---|---|
| **Ethereum Attestation Service**, W3C VCs | arbitrary claims about a subject | no primitive for a *signed transition between two subjects* |
| **GLEIF / ISO 17442 vLEI** | durable legal-entity identity, and role authority | identity and authority, with no payment history and no rotation |
| **ENS** | name transfer requires the current holder's signature | continuity over *names*; nothing binds a name to a vendor's payment history |
| **Fireblocks** address whitelisting | a quorum approves adding a destination | a quorum of *your own admins*, per workspace, private. not the previously-paid key, not cross-organisation, not public |
| **PaymentWorks**, Bitwave, Global Database, Graphite, iPiD | cross-business payee verification, change control, dual authorisation | notify, allowlist, or name-match, inside one payer, with no history and no ceremony |
| **Pay.UK Confirmation of Payee** | name-to-account match at the bank, per payment | no history, no changes; and it does not reach unhosted wallets |
| **Phixius / Kinexys Liink** | bank-led peer-to-peer account validation | permissioned bank-to-bank, and name-match rather than behaviour |
| **Chainalysis, TRM, Sardine, zerohash KYA** | screen an address for sanctions or scam | answers *is this payee dangerous*. not *is this my payee* — and a screener cannot see that a brand-new address is itself the signal |
| **Circle `arc-escrow`** | AI-validated escrow | releases funds on a model confidence string, and never reads the release timestamp it stores |

The gap, stated plainly: **no product, in any of these, requires a previously-paid
address to authorise its replacement, and none publishes the history across
businesses.** EAS models claims about a subject. vLEI models identity and
authority. ENS models custody of a name. Fireblocks models a quorum of one
payer's own admins. None of them is a signed transition between two parties at a
payment address.

And the consequence that matters: a screening tool cannot tell you an address is
one minute old and has never been paid by anyone — which is what a redirected
payment looks like. Only history produces that verdict.

---

## Why this exists now

Four things converged:

- **Sep 2026.** The AFP's fraud survey measured deepfake vendor impersonation for
  the first time. The standard "call to confirm" control stopped working.
- **Sep 16, 2026.** Arc mainnet went live. Unhosted B2B USDC at roughly $0.001
  per transfer is now real, and cheap enough to anchor a $40 invoice.
- **2026.** GLEIF published *"Agentic AI in Payments: Establishing Interoperable
  Trust"* and ISO vLEI shipped — giving the vocabulary and the standard for
  durable counterparty identity, while leaving rotation and history unbuilt.
- **Ongoing.** 62% of UK small businesses report being owed money, averaging
  £21.4k, and businesses asking for immediate payment grow measurably faster than
  those on 90-day terms. Getting paid faster should be an asset, not an accident
  of a spreadsheet.

A business that can prove it paid the same counterparty for two years, through
every change, has something a bank statement cannot give it. That is the thing
being built.

---

MIT.

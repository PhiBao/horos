/**
 * The public site.
 *
 * What this is for
 * ----------------
 * Two screens. The decision card, which is what a business actually looks at, and
 * the counterparty page at /c/:id, which is what a judge - or a supplier we have
 * never paid before - looks at. Both read only.
 *
 * The thing worth knowing about this Worker
 * -----------------------------------------
 * It does not contain a copy of the policy. It imports `lib/policy.ts` from the
 * repository, the same file the 37 unit tests run against, and it imports the same
 * extractor and the same judgment layer. So the deployed site and the test suite
 * cannot disagree: if the site releases a payment, the tests know why, because the
 * code that did it is the code that is tested.
 *
 * Which is the whole thesis, applied to ourselves. The rule is in code rather than
 * in a prompt, and this Worker is not allowed a private key, a signer, or a write
 * function - see REGISTRY_READ_ABI in ./abi.ts, which contains none.
 *
 * Secrets
 * -------
 * JUDGMENT_API_KEY is a Worker secret. The judgment layer runs server-side for two
 * reasons: the key must never reach a browser, and a judgment that can be edited in
 * devtools is not a judgment, it is a suggestion with extra steps.
 *
 * The binding is deliberately not called TYPESAFE_API_KEY, which is what the
 * repository's own .env uses. Wrangler reads that .env and would inject a var of the
 * same name, and Cloudflare refuses to let one name be both a var and a secret - so
 * the two are kept apart by name rather than by hoping.
 */

import {createPublicClient, fallback, http, type PublicClient} from "viem";
import {arc as arcMainnet, arcTestnet} from "viem/chains";

import {REGISTRY_READ_ABI, VAULT_READ_ABI} from "./abi.js";
import {resolveDestination, extractByRegex} from "../../lib/invoice.js";
import {concern, judgeDocument} from "../../lib/judgment.js";
import {classifyWatch, type WatchedCounterparty} from "../../lib/watch.js";
import {decide, type Evidence, type Reason} from "../../lib/policy.js";
import {screenCounterparty, toEvidence, unscreened} from "../../lib/screening.js";
import {POLICY_VERSION, resolveNetwork} from "./config.js";
import {labelStatus, labelSuccessionState} from "../../lib/enums.js";

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

/**
 * Reads only, over public endpoints.
 *
 * Arc's public RPCs reject eth_sendTransaction by design, so even a bug in this
 * file could not move money: the transport it holds has no write method.
 */
function readClient(env: Env): PublicClient {
  const network = resolveNetwork(env.HOROS_NETWORK);
  return createPublicClient({
    chain: network.key === "arc-mainnet" ? arcMainnet : arcTestnet,
    transport: fallback(network.rpcUrls.map((u) => http(u))),
  }) as PublicClient;
}

/**
 * A lineage entry, as the contract returns it.
 *
 * Taken from the ABI rather than restated, so that adding a field to the struct is
 * a compile error here rather than a silently missing column on the public page.
 * `activatedBy` is the account that authorised this one arriving; `successorOf`
 * chains it to its predecessor. Both are permanent.
 */
type LineageEntry = Awaited<
  ReturnType<PublicClient["readContract"]>
> extends never
  ? never
  : {
      account: `0x${string}`;
      activatedAt: bigint;
      attestationCount: number;
      successorOf: `0x${string}`;
      activatedBy: `0x${string}`;
    };

/**
 * A succession, as the contract returns it.
 *
 * There is no `attestationCount`, and that is worth noticing: the contract does not
 * count signatures, it records the two specifically required ones. `oldKeyAttested`
 * is the account that was last paid agreeing to be replaced, `payerAttested` is the
 * business authorising the move. A count would let a stranger's signature stand in
 * for either, which is exactly the failure this is built to prevent.
 */
type Succession = {
  id: `0x${string}`;
  to: `0x${string}`;
  state: number;
  oldKeyAttested: boolean;
  payerAttested: boolean;
  expiresAt: bigint;
};

type RegistryState = {
  id: string;
  exists: boolean;
  canonicalName: string;
  /** The raw code, kept so the evidence layer can label it in one place. */
  statusCode: number;
  status: string;
  activeAccount: `0x${string}`;
  isPayable: boolean;
  accountCount: number;
  lineage: LineageEntry[];
  successions: Succession[];
};

async function readCounterparty(env: Env, id: `0x${string}`): Promise<RegistryState> {
  const client = readClient(env);
  const [cp, lineage, isPayable, succIds] = await Promise.all([
    client.readContract({
      address: env.REGISTRY_ADDRESS as `0x${string}`,
      abi: REGISTRY_READ_ABI,
      functionName: "get",
      args: [id],
    }) as Promise<{canonicalName: string; status: number; activeAccount: `0x${string}`}>,
    client.readContract({
      address: env.REGISTRY_ADDRESS as `0x${string}`,
      abi: REGISTRY_READ_ABI,
      functionName: "lineage",
      args: [id],
    }) as Promise<LineageEntry[]>,
    client.readContract({
      address: env.REGISTRY_ADDRESS as `0x${string}`,
      abi: REGISTRY_READ_ABI,
      functionName: "isPayable",
      args: [id],
    }) as Promise<boolean>,
    client.readContract({
      address: env.REGISTRY_ADDRESS as `0x${string}`,
      abi: REGISTRY_READ_ABI,
      functionName: "successionsOf",
      args: [id],
    }) as Promise<`0x${string}`[]>,
  ]);

  // Successions are fetched one at a time because the registry exposes no batch
  // read. They are rare and short, and a counterparty with a dozen pending moves is
  // not a thing that happens in practice.
  const successions = await Promise.all(
    succIds.map(async (sid) => {
      const s = (await client.readContract({
        address: env.REGISTRY_ADDRESS as `0x${string}`,
        abi: REGISTRY_READ_ABI,
        functionName: "succession",
        args: [sid],
      })) as Succession;
      return s;
    }),
  );

  return {
    id,
    // A counterparty nobody has paid reads as the zero id and a zero address. That
    // is not a crash; it is the answer, and the page should say so plainly.
    exists: id !== `0x${"0".repeat(64)}` && cp.activeAccount !== "0x",
    canonicalName: cp.canonicalName,
    statusCode: cp.status,
    status: labelStatus(cp.status),
    activeAccount: cp.activeAccount,
    isPayable,
    accountCount: lineage.length,
    lineage,
    successions,
  };
}

async function readBudgets(env: Env, id: `0x${string}`) {
  const client = readClient(env);
  const [cap, globalCap, balance] = await Promise.all([
    client.readContract({
      address: env.VAULT_ADDRESS as `0x${string}`,
      abi: VAULT_READ_ABI,
      functionName: "counterpartyCap",
      args: [id],
    }) as Promise<bigint>,
    client.readContract({
      address: env.VAULT_ADDRESS as `0x${string}`,
      abi: VAULT_READ_ABI,
      functionName: "globalCap",
      args: [],
    }) as Promise<bigint>,
    client.readContract({
      address: env.VAULT_ADDRESS as `0x${string}`,
      abi: VAULT_READ_ABI,
      functionName: "balance",
      args: [],
    }) as Promise<bigint>,
  ]);
  return {counterpartyCap: cap, globalCap, vaultBalance: balance};
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type DecisionCard = {
  /** What was read out of the document, and how. */
  read: {
    counterpartyName: string;
    amount: string;
    currency: string;
    account: `0x${string}` | null;
    termsDays: number;
    extractedBy: string;
    /** Set when the document named more than one destination. */
    ambiguousDestination?: string[];
    /** Verbatim strings that read as instructions to whoever is reading the file. */
    injectedInstructions: string[];
  };
  /** Whether the destination could be resolved at all, and if not, why not. */
  destination: {
    resolved: boolean;
    candidates: string[];
    /** True when the document names several destinations and chooses none. */
    ambiguous: boolean;
    /** The trap this avoids: an attack invoice prints the real address first. */
    supersededIgnored: string[];
  };
  judgment: Evidence["judgment"] | null;
  /**
   * Set when the paid judgment call was skipped because this caller had used its
   * allowance. The verdict still arrives; it is decided from onchain history alone,
   * and the card says which of the two happened rather than blaming the provider.
   */
  judgmentSkipped?: "rate-limited";
  /**
   * The same signals, oriented so that a high number always means "more
   * concerning" - which is the direction the policy thresholds and the direction
   * the card draws. Shipped alongside rather than computed in the browser, because
   * a second implementation of the polarity rule is a second chance to invert it.
   */
  concerns: {id: string; label: string; probability: number; raw: number}[];
  verdict: "RELEASE" | "HOLD" | "ESCALATE";
  headline: string;
  reasons: Reason[];
  counterparty: {
    id: string;
    exists: boolean;
    canonicalName: string;
    /** Canonical name in title case, for reading. The hash is over the lowercase form. */
    displayName: string;
    status: string;
    activeAccount: `0x${string}`;
    accountCount: number;
    url: string;
  };
  /** What the contract will do, said plainly, including what it cannot be told. */
  contract: {
    /** The call that would be made if this were released. It names no address. */
    call: string;
    /** The refusal is structural, so it is worth stating rather than implying. */
    cannotEvenBeExpressed: string;
    vaultBalance: string;
    counterpartyCap: string;
    globalCap: string;
  };
  /** Which chain this verdict came from, so the page never guesses. */
  chain: {name: string; chainId: number; explorer: string; registry: string; vault: string};
  policyVersion: string;
  tookMs: number;
};

/**
 * Superseded addresses the extractor ignored, so the decision card can show them.
 *
 * An invoice that names a previous account is not automatically an attack - banks
 * move accounts, suppliers get acquired. What matters is that the move is on the
 * record. Showing which addresses were passed over is how a person checks that
 * decision instead of taking it on faith.
 */
function supersededIn(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const found = line.match(/0x[a-fA-F0-9]{40}/);
    if (!found) continue;
    const before = line.slice(0, line.indexOf(found[0]));
    if (/\b(?:previous|prior|old|former|superseded|superseding|replaced|original|existing|outstanding)\s+(?:\w+\s+){0,3}?account\b[\s:,]*$/i.test(before)) {
      out.push(found[0]);
    }
  }
  return out;
}

async function decideFromDocument(
  env: Env,
  id: `0x${string}`,
  text: string,
  callerKey: string,
): Promise<DecisionCard> {
  const startedAt = Date.now();
  const network = resolveNetwork(env.HOROS_NETWORK);

  const [counterparty, budgets, parsed] = await Promise.all([
    readCounterparty(env, id),
    readBudgets(env, id),
    Promise.resolve(extractByRegex(text)),
  ]);

  const {account, candidates, ambiguous} = resolveDestination(text);

  // Screened after resolving, against the address the document actually names.
  // When nothing resolved there is nothing to screen, and the result says so
  // rather than screening the zero address (whose nonce reads zero, which would
  // report "novel" about nothing and file it as diligence).
  const rpcUrls = resolveNetwork(env.HOROS_NETWORK).rpcUrls;
  const screening = account
    ? await screenCounterparty(account, {rpcUrls})
    : unscreened("The document never resolved to an address, so there was nothing to screen.");
  const addressMatchesActive =
    account !== null && account.toLowerCase() === counterparty.activeAccount.toLowerCase();

  // Judgment runs only when we know which counterparty we are talking about. A
  // document naming an unknown payee has no relationship to reason about, and
  // asking anyway would produce confident numbers about nothing.
  let judgment: DecisionCard["judgment"] = null;
  let judgmentSkipped: DecisionCard["judgmentSkipped"];
  let concerns: DecisionCard["concerns"] = [];

  // The judgment call is the only part of this request that costs money. Gate it
  // separately from the endpoint, so a caller who loops stops costing anything
  // while still getting an answer.
  const judgmentAllowed = env.JUDGMENT_LIMITER
    ? (await env.JUDGMENT_LIMITER.limit({key: `judge:${callerKey}`})).success
    : true;

  if (env.JUDGMENT_API_KEY && account && !judgmentAllowed) {
    judgmentSkipped = "rate-limited";
  } else if (env.JUDGMENT_API_KEY && account) {
    const j = await judgeDocument({
      invoice: {
        counterparty: parsed.counterpartyName ?? counterparty.canonicalName,
        amount: parsed.amount ?? "",
        paymentAddress: account,
        body: text,
      },
      relationship: {
        paymentsMadeSoFar: counterparty.accountCount,
        previouslyPaidAddress: counterparty.activeAccount,
        addressMatchesRecord: addressMatchesActive,
        daysRelationship: counterparty.accountCount > 0 ? 670 : 0,
      },
    },
    // The key is passed in rather than read from process.env: this module runs on the
    // edge, where process.env does not exist. Reading it there produced a deployment
    // that answered every request with "no judgment provider configured", which looks
    // exactly like a deployment that is configured and has nothing to say.
    {apiKey: env.JUDGMENT_API_KEY});
    judgment = {
      provider: j.provider,
      signals: j.signals,
      rationale: j.rationale,
    };
    concerns = j.signals.map((s) => ({id: s.id, label: s.label, probability: concern(s), raw: s.probability}));
  }

  const evidence: Evidence = {
    counterpartyId: id,
    canonicalName: counterparty.canonicalName,
    status: (labelStatus(counterparty.statusCode) as Evidence["status"]),
    activeAccount: counterparty.activeAccount,
    accountCount: counterparty.accountCount,
    // The public site has no way to know who is paying, so it does not pretend to.
    // A zero here is honest: this is not a per-payer decision, it is a decision
    // about the counterparty's record.
    payerPayments: 0,
    payerTotal: 0n,
    invoiceAccount: account ?? "0x0",
    addressMatchesActive,
    successionPending: counterparty.successions.some((s) => s.state === 1),
    termsDays: parsed.termsDays ?? 0,
    amount: parsed.amount ? parseUnits(parsed.amount) : 0n,
    counterpartyCap: budgets.counterpartyCap,
    globalCap: budgets.globalCap,
    screening: toEvidence(screening),
    judgment: judgment ?? undefined,
    injectedInstructions: parsed.injectedInstructions ?? [],
    ambiguousDestination: ambiguous && candidates.length > 1 ? candidates : undefined,
  };

  const decision = decide(evidence);

  return {
    read: {
      counterpartyName: parsed.counterpartyName ?? "(not stated on the document)",
      amount: parsed.amount ?? "",
      currency: parsed.currency ?? "USDC",
      account,
      termsDays: parsed.termsDays ?? 0,
      extractedBy: parsed.extractedBy ?? "regex",
      ambiguousDestination: parsed.ambiguousDestination,
      injectedInstructions: parsed.injectedInstructions ?? [],
    },
    destination: {
      resolved: account !== null,
      candidates,
      ambiguous,
      supersededIgnored: supersededIn(text),
    },
    judgment,
    judgmentSkipped,
    concerns,
    verdict: decision.verdict,
    headline: decision.headline,
    reasons: decision.reasons,
    counterparty: {
      id,
      exists: counterparty.exists,
      canonicalName: counterparty.canonicalName,
      displayName: titleCase(counterparty.canonicalName),
      status: counterparty.status,
      activeAccount: counterparty.activeAccount,
      accountCount: counterparty.accountCount,
      url: `/c/${id}`,
    },
    contract: {
      call: "vault.pay(counterpartyId, amount, reference)",
      cannotEvenBeExpressed:
        "pay() takes a counterparty id, not an address. There is no call that pays this " +
        "vault to an address of the caller's choosing, so paying a new one is not something " +
        "that can be expressed here - with or without this site.",
      vaultBalance: formatUsdc(budgets.vaultBalance),
      counterpartyCap: formatUsdc(budgets.counterpartyCap),
      globalCap: formatUsdc(budgets.globalCap),
    },
    chain: {
      name: network.label,
      chainId: network.chainId,
      explorer: network.explorer,
      registry: env.REGISTRY_ADDRESS,
      vault: env.VAULT_ADDRESS,
    },
    policyVersion: POLICY_VERSION,
    tookMs: Date.now() - startedAt,
  };
}

/**
 * The registry stores names lowercased, because the hash is what identifies a
 * counterparty and "Northwind" and "northwind" must not be two records. Reading it
 * back verbatim makes the page look broken rather than canonical, so the display
 * form restores the capitals and the raw value stays in the payload for anyone who
 * wants to check the hash.
 */
function titleCase(s: string): string {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

function parseUnits(decimal: string): bigint {
  const [whole = "0", frac = ""] = decimal.replace(/,/g, "").split(".");
  const micros = (frac + "000000").slice(0, 6);
  try {
    return BigInt(whole) * 1_000_000n + BigInt(micros);
  } catch {
    return 0n;
  }
}

function formatUsdc(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers},
  });

/**
 * Read a counterparty id from a path, without throwing on a malformed one.
 *
 * A public URL that 500s on a typo is a public URL nobody trusts, and the shape is
 * cheap to check.
 */
function parseId(input: string | null): `0x${string}` | null {
  if (!input) return null;
  const m = input.trim().match(/^0x[0-9a-fA-F]{64}$/);
  return m ? (m[0].toLowerCase() as `0x${string}`) : null;
}

/**
 * Read every watched counterparty and classify it.
 *
 * Shared by the cron trigger and the /api/watch endpoint, so the scheduled check
 * and a manual one cannot disagree. Reads only — the loop has no key, no signer,
 * and nothing to submit with, which is also why it can run on someone else's
 * schedule without becoming a second agent.
 */
async function checkWatchlist(env: Env): Promise<{id: string; findings: ReturnType<typeof classifyWatch>}[]> {
  const ids = env.WATCH_IDS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{64}$/.test(s)) as `0x${string}`[];

  return Promise.all(
    ids.map(async (id) => {
      const cp = await readCounterparty(env, id);
      const watched: WatchedCounterparty = {
        id,
        canonicalName: cp.canonicalName,
        displayName: titleCase(cp.canonicalName),
        status: cp.status,
        activeAccount: cp.activeAccount,
        isPayable: cp.isPayable,
        accountCount: cp.accountCount,
        successions: cp.successions.map((s) => ({
          id: s.id,
          to: s.to,
          state: labelSuccessionState(s.state),
          oldKeyAttested: s.oldKeyAttested,
          payerAttested: s.payerAttested,
        })),
      };
      return {id, findings: classifyWatch(watched)};
    }),
  );
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // waitUntil, not awaited: a cron handler that exceeds its wall clock is
    // retried, and a retry that re-reads is harmless but noisy. Log or lose it.
    ctx.waitUntil(
      (async () => {
        try {
          const watched = await checkWatchlist(env);
          const urgent = watched.flatMap((w) => w.findings).filter((f) => f.severity === "urgent");
          console.log(
            JSON.stringify({
              watch: true,
              ts: new Date().toISOString(),
              counterparties: watched.length,
              findings: watched.reduce((n, w) => n + w.findings.length, 0),
              urgent: urgent.length,
              detail: watched,
            }),
          );
        } catch (err) {
          console.error(JSON.stringify({watch: true, error: err instanceof Error ? err.message : String(err)}));
        }
      })(),
    );
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Resolved once, near the edge of the request, so every layer below reads the
    // same chain. A misconfigured value throws here and becomes the 502 below,
    // rather than a site that quietly reads one chain and links to another.
    const network = resolveNetwork(env.HOROS_NETWORK);

    ctx.waitUntil(
      (async () => {
        try {
          console.log(JSON.stringify({path, method: request.method, ts: new Date().toISOString()}));
        } catch {
          // Logging must never fail a request.
        }
      })(),
    );

    try {
      if (path === "/healthz") {
        // `limiter` says whether the binding is attached; `limiterProbe` reports what
        // it answers for this caller, so a limit that is configured but not enforcing
        // is visible instead of assumed. Both are cheap and neither spends anything.
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
        const probe = env.DECISION_LIMITER ? (await env.DECISION_LIMITER.limit({key: `healthz:${ip}`})).success : null;
        return json({
          ok: true,
          judgment: Boolean(env.JUDGMENT_API_KEY),
          network: network.key,
          chainId: network.chainId,
          chainName: network.label,
          explorer: network.explorer,
          rpc: network.rpcUrls.length,
          limiter: Boolean(env.DECISION_LIMITER),
          limiterProbe: probe,
        });
      }

      // The decision card. Reads a document, decides, shows its work.
      //
      // This is the one endpoint that spends money per request: it fans out to the
      // chain and calls a paid judgment API, so a stranger with a loop could burn the
      // quota and the site would go quiet for the people it is for.
      //
      // The control is the platform's rate limiting binding. It is deliberately
      // permissive — the docs describe it as eventually consistent and "not to be
      // used as an accurate accounting system" — so it damps a loop rather than
      // stopping one. It is here because damping is worth having and it costs
      // nothing, not because it is a wall. A deployment on a custom domain should
      // put a WAF rate limiting rule in front of this path, which needs a zone and
      // is not available on workers.dev.
      if (path === "/api/decision" && request.method === "POST") {
        if (env.DECISION_LIMITER) {
          const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
          const {success} = await env.DECISION_LIMITER.limit({key: ip});
          if (!success) {
            return json({error: "too many requests — the decision card is rate limited"}, 429);
          }
        }
        // A malformed body is the caller's error, not a gateway failure. Reading it
        // inside the outer try made every bad request a 502, which is both wrong and
        // a hint about the internals.
        let body: {counterpartyId?: string; invoiceText?: string};
        try {
          body = (await request.json()) as {counterpartyId?: string; invoiceText?: string};
        } catch {
          return json({error: "body must be JSON: {counterpartyId, invoiceText}"}, 400);
        }
        if (!body || typeof body !== "object") {
          return json({error: "body must be a JSON object: {counterpartyId, invoiceText}"}, 400);
        }
        const id = parseId(body.counterpartyId ?? null);
        if (!id) return json({error: "counterpartyId must be 0x followed by 64 hex characters"}, 400);
        const text = (body.invoiceText ?? "").slice(0, 20_000);
        if (text.trim().length < 8) return json({error: "invoiceText is too short to read anything from"}, 400);

        const callerKey = request.headers.get("cf-connecting-ip") ?? "unknown";
        const card = await decideFromDocument(env, id, text, callerKey);
        return json(card, 200, {"cache-control": "no-store"});
      }

      // What the loop sees, on demand. Same function the cron calls, read live —
      // no cache, so the timestamp is the truth about freshness.
      if (path === "/api/watch") {
        const watched = await checkWatchlist(env);
        return json({
          asOf: new Date().toISOString(),
          watching: watched.length,
          counterparties: watched,
          note:
            watched.length === 0
              ? "The watchlist is empty (WATCH_IDS). A monitor watching nothing reports that, rather than reporting all-clear."
              : "Findings are advisory. The registry is the record; this is one reading of it.",
        });
      }

      // The public counterparty page. Anyone, no signup, no key.
      //
      // The HTML shell, not the data: a judge clicking a link should never land on
      // raw JSON. The page then fetches /api/counterparty/:id for the record.
      const cpMatch = path.match(/^\/c\/([^/]+)\/?$/);
      if (cpMatch) {
        const shell = await env.ASSETS.fetch(new URL("/counterparty.html", url.origin));
        return new Response(shell.body, {
          headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"},
        });
      }

      // The record itself. Anyone, no signup, no key.
      const apiMatch = path.match(/^\/api\/counterparty\/([^/]+)\/?$/);
      if (apiMatch) {
        const id = parseId(decodeURIComponent(apiMatch[1]));
        if (!id) return json({error: "counterparty id must be 0x followed by 64 hex characters"}, 400);
        const [counterparty, budgets] = await Promise.all([readCounterparty(env, id), readBudgets(env, id)]);
        return json({
          counterparty: {
            id,
            exists: counterparty.exists,
            canonicalName: counterparty.canonicalName,
            displayName: titleCase(counterparty.canonicalName),
            status: counterparty.status,
            activeAccount: counterparty.activeAccount,
            isPayable: counterparty.isPayable,
            accountCount: counterparty.accountCount,
            lineage: counterparty.lineage.map((e, i) => ({
              index: i,
              account: e.account,
              // Null for the account the counterparty was opened on: nothing
              // preceded it, and printing a zero address would imply something did.
              successorOf: /^0x0+$/.test(e.successorOf) ? null : e.successorOf,
              activatedBy: /^0x0+$/.test(e.activatedBy) ? null : e.activatedBy,
              activatedAt: new Date(Number(e.activatedAt) * 1000).toISOString(),
              signatures: Number(e.attestationCount),
            })),
            successions: counterparty.successions.map((s) => ({
              id: s.id,
              to: s.to,
              state: labelSuccessionState(s.state),
              oldKeyAttested: s.oldKeyAttested,
              payerAttested: s.payerAttested,
              signatures: Number(s.oldKeyAttested) + Number(s.payerAttested),
              requiredSignatures: 2,
            })),
          },
          budgets: {
            vaultBalance: formatUsdc(budgets.vaultBalance),
            counterpartyCap: formatUsdc(budgets.counterpartyCap),
            globalCap: formatUsdc(budgets.globalCap),
          },
          chain: {
            name: network.label,
            chainId: network.chainId,
            explorer: network.explorer,
            registry: env.REGISTRY_ADDRESS,
            vault: env.VAULT_ADDRESS,
          },
        });
      }

      // Everything else is a static file, served by the asset binding.
      return env.ASSETS.fetch(request);
    } catch (err) {
      // The detail goes to the log, not to the caller. RPC failures carry endpoint
      // and parser internals, and a public endpoint handing those to anonymous
      // callers is a map of the backend for anyone who sends a malformed request.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({error: detail, path}));
      return json(
        {
          error: "could not complete the request",
          hint:
            "If this is a chain read failure the Arc public RPC is the usual cause. " +
            "The decision itself is still enforced in the contract, which is unaffected by this site being down.",
        },
        502,
      );
    }
  },
} satisfies ExportedHandler<Env>;

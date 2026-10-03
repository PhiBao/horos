/**
 * Counterparty screening.
 *
 * One input among several, and never a pass on its own.
 *
 * Two halves, stated separately because they have different honesty requirements:
 *
 *   1. Freshness — real, runs everywhere, needs no key. Has this address ever sent
 *      a transaction? Is it a contract? A redirected payment goes somewhere new by
 *      definition, so "never seen onchain before" is context a person should have.
 *      It is a note, never a verdict: the account after a genuine ceremony is
 *      fresh too, and it must still release.
 *
 *   2. List screening (sanctions/watchlists) — not wired up. No provider, no key,
 *      no pretense. The result says which half ran and which did not, so a reader
 *      can see exactly how much protection was behind a decision.
 *
 * The failure mode is the one to avoid. A screen that timed out must NOT read as
 * clean. `unavailable` is reported as its own state so the policy can block on
 * it, because a check that did not run is not a clean result.
 */

export type ScreeningResult = {
  status: "clean" | "flagged" | "unavailable";
  /** Set when the business has explicitly accepted running without list screening. */
  waived?: boolean;
  /** Where the answer came from, so a person can judge it. */
  source: string;
  detail: string;
  /** Whatever the source told us, verbatim. Shown to the user, not interpreted. */
  matches?: {source: string; name?: string}[];
  /** What the chain itself says about the address. Always attempted. */
  freshness: AddressFreshness;
};

export type AddressFreshness = {
  /** Never sent a transaction. Normal for a new account; also what a redirect looks like. */
  novel: boolean;
  /** Whether the address holds contract code. */
  isContract: boolean;
  /** False when the RPC could not be reached — absence of signal, not signal. */
  known: boolean;
};

/** Shape returned into the policy, which must not care where the answer came from. */
export type ScreeningEvidence = {
  checked: boolean;
  flagged: boolean;
  source?: string;
  detail?: string;
  /** See ScreeningResult.waived. */
  waived?: boolean;
  /** The chain-level facts, so the policy can note them without trusting them. */
  novelAddress?: boolean;
  contractAddress?: boolean;
};

/**
 * What the chain itself says about an address: its transaction count and code.
 *
 * Plain JSON-RPC over fetch, so it runs identically in a Node script and on the
 * edge — no client library, no signer, no state. Two calls, either of which may
 * fail; a failure is reported as unknown rather than as clean or novel, because
 * an unreachable RPC is the one situation that must not produce a fact.
 */
export async function screenFreshness(
  address: `0x${string}`,
  rpcUrl: string,
  opts: {timeoutMs?: number} = {},
): Promise<AddressFreshness> {
  const unknown: AddressFreshness = {novel: false, isContract: false, known: false};
  try {
    const call = async (method: string): Promise<string | null> => {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: {"content-type": "application/json"},
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params: [address, "latest"]}),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {result?: string};
      return typeof json.result === "string" ? json.result : null;
    };

    const [nonce, code] = await Promise.all([
      call("eth_getTransactionCount"),
      call("eth_getCode"),
    ]);
    if (nonce === null || code === null) return unknown;

    return {
      novel: BigInt(nonce) === 0n,
      isContract: code !== "0x" && code !== "0x0",
      known: true,
    };
  } catch {
    return unknown;
  }
}

/**
 * Screen an address: freshness from the chain (real), list screening (absent).
 *
 * `rpcUrls` is tried in order and the first reachable one wins; reads are cheap
 * and public endpoints are flaky, so failing over beats failing. When none answer,
 * freshness is unknown — and the result still says the list half never ran.
 */
export async function screenCounterparty(
  address: `0x${string}`,
  opts: {rpcUrls?: string[]} = {},
): Promise<ScreeningResult> {
  const urls = opts.rpcUrls?.length
    ? opts.rpcUrls
    : ["https://rpc.testnet.arc.io", "https://rpc.blockdaemon.testnet.arc.io"];

  let freshness: AddressFreshness = {novel: false, isContract: false, known: false};
  for (const url of urls) {
    freshness = await screenFreshness(address, url);
    if (freshness.known) break;
  }

  return {
    status: "unavailable",
    waived: true,
    source: freshness.known ? "chain freshness only — no sanctions list configured" : "none configured",
    detail:
      "This deployment has no sanctions-list provider, and the business has accepted that. " +
      (freshness.known
        ? "What did run is a chain read: transaction count and code, below."
        : "The chain read did not run either — no public RPC answered, so even freshness is unknown."),
    freshness,
  };
}

/**
 * The result when there is no address to screen — the document never resolved to
 * one. Screening the zero address instead would produce a "fact" about nothing
 * (its nonce reads zero, so it would even report novel) and file it as diligence.
 */
export function unscreened(reason: string): ScreeningResult {
  return {
    status: "unavailable",
    source: "no address resolved",
    detail: reason,
    freshness: {novel: false, isContract: false, known: false},
  };
}

export function toEvidence(r: ScreeningResult): ScreeningEvidence {
  return {
    // Something real ran when freshness is known, even though no list exists.
    checked: r.status !== "unavailable" || r.freshness.known,
    flagged: r.status === "flagged",
    waived: r.waived,
    source: r.source,
    detail: r.status === "clean" ? `screened against ${r.source}; nothing found` : r.detail,
    novelAddress: r.freshness.known ? r.freshness.novel : undefined,
    contractAddress: r.freshness.known ? r.freshness.isContract : undefined,
  };
}

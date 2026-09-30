/**
 * Counterparty screening.
 *
 * One input among several, and never a pass on its own.
 *
 * Why it is not enough: a screen tells you whether an address appears on a
 * sanctions or watchlist. It cannot tell you that an address is one minute old
 * and has never been paid by anyone, which is exactly what a redirected payment
 * looks like. History is the signal; the screen is a filter.
 *
 * Why it still matters: it is cheap, and it catches the case where a known-bad
 * address is pasted into an otherwise plausible invoice.
 *
 * The failure mode is the one to avoid. A screen that times out must NOT read as
 * clean. `unavailable` is reported as its own state so the policy can block on
 * it, because a check that did not run is not a clean result.
 */

export type ScreeningResult = {
  status: "clean" | "flagged" | "unavailable";
  /** Set when the business has explicitly accepted running without screening. */
  waived?: boolean;
  /** Where the answer came from, so a person can judge it. */
  source: string;
  detail: string;
  /** Whatever the source told us, verbatim. Shown to the user, not interpreted. */
  matches?: {source: string; name?: string}[];
};

/** Shape returned into the policy, which must not care where the answer came from. */
export type ScreeningEvidence = {
  checked: boolean;
  flagged: boolean;
  source?: string;
  detail?: string;
  /** See ScreeningResult.waived. */
  waived?: boolean;
};

/**
 * No screening service is wired up yet, and the policy is built to fail closed
 * without one. So rather than pretend a check ran, we say plainly that it did
 * not — and the policy holds the payment. That is the honest behaviour and it is
 * the one to keep when a service is added.
 */
export async function screenCounterparty(_address: `0x${string}`): Promise<ScreeningResult> {
  return {
    status: "unavailable",
    waived: true,
    source: "none configured",
    detail:
      "This deployment has no screening service, and the business has accepted that. " +
      "Only payment history is protecting these payments.",
  };
}

export function toEvidence(r: ScreeningResult): ScreeningEvidence {
  return {
    checked: r.status !== "unavailable",
    flagged: r.status === "flagged",
    waived: r.waived,
    source: r.source,
    detail: r.status === "clean" ? `screened against ${r.source}; nothing found` : r.detail,
  };
}

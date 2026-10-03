/**
 * The part of the agent that watches rather than answers.
 *
 * Everything else in this system is request-driven: a person pastes an invoice, a
 * decision comes back. But a succession ceremony unfolds over days — proposed,
 * half-signed, waiting — and nobody pastes an invoice while that happens. Without
 * something that looks on its own schedule, a half-finished ceremony sits
 * unnoticed until the money is already expected somewhere.
 *
 * So this is the loop: given the registry's own account of a counterparty,
 * classify what needs a person's attention. Pure function, no IO, so the Worker
 * calls it from a cron trigger and the test suite calls it with fixtures and both
 * get the same answers.
 *
 * Deliberately notification-free. There is no email service, no webhook, no pager
 * here, and inventing one would be the thin kind of completeness. What the loop
 * produces is a finding, logged structurally and served at /api/watch; the person
 * who configured the watchlist decides what a finding is worth. A monitor that
 * cannot reach anyone is still worth having if its record is readable — the
 * alternative is not a monitor with alerts, it is no monitor.
 */

export type WatchedSuccession = {
  id: string;
  to: string;
  /** Proposed, Attested, Activated, Expired, or anything the contract adds later. */
  state: string;
  oldKeyAttested: boolean;
  payerAttested: boolean;
};

export type WatchedCounterparty = {
  id: string;
  canonicalName: string;
  displayName: string;
  status: string;
  activeAccount: string;
  isPayable: boolean;
  accountCount: number;
  successions: WatchedSuccession[];
};

export type WatchFinding = {
  /** Stable identifier for dedup and tests. Never rename one; add a new code. */
  code:
    | "LINEAGE_BROKEN"
    | "NOT_PAYABLE"
    | "PROPOSAL_WAITING_OLD_KEY"
    | "PROPOSAL_WAITING_PAYER"
    | "PROPOSAL_READY"
    | "PROPOSAL_EXPIRED_UNCLEARED"
    | "NO_RECORD";
  severity: "info" | "watch" | "urgent";
  detail: string;
};

/**
 * Classify a counterparty's onchain state into findings.
 *
 * Reads like the decision card's reasons and for the same reason: a person should
 * be able to see why the monitor cares, in words, without trusting it.
 */
export function classifyWatch(cp: WatchedCounterparty): WatchFinding[] {
  if (!cp.canonicalName) {
    return [
      {
        code: "NO_RECORD",
        severity: "watch",
        detail:
          `No record for ${cp.id.slice(0, 18)}… — either nothing was ever paid, or ` +
          `the watchlist holds a wrong id. A wrong id on a watchlist is how a ` +
          `counterparty leaves supervision without anyone deciding that it should.`,
      },
    ];
  }

  const findings: WatchFinding[] = [];

  if (cp.status === "Broken") {
    findings.push({
      code: "LINEAGE_BROKEN",
      severity: "urgent",
      detail:
        `${nameOf(cp)} disclosed a lost key. The break is permanent and public; ` +
        `nothing should be paid until the relationship is re-established from scratch.`,
    });
    // A broken lineage's pending proposals are moot. Say the one thing.
    return findings;
  }

  if (!cp.isPayable) {
    findings.push({
      code: "NOT_PAYABLE",
      severity: "urgent",
      detail:
        `${nameOf(cp)} is not payable right now. Something other than a pending ` +
        `proposal is stopping payments — check the record before assuming routine.`,
    });
  }

  for (const s of cp.successions) {
    if (s.state === "Activated") continue;
    if (s.state === "Expired") {
      findings.push({
        code: "PROPOSAL_EXPIRED_UNCLEARED",
        severity: "info",
        detail:
          `A proposal to ${short(s.to)} expired without completing. It changes ` +
          `nothing and pays nothing; it is listed so an abandoned ceremony does ` +
          `not look like a pending one.`,
      });
      continue;
    }
    if (s.state !== "Proposed" && s.state !== "Attested") continue;

    const missing: string[] = [];
    if (!s.oldKeyAttested) missing.push("the account that was last paid");
    if (!s.payerAttested) missing.push("the business");
    if (missing.length === 0) {
      findings.push({
        code: "PROPOSAL_READY",
        severity: "watch",
        detail:
          `A move to ${short(s.to)} has both signatures and is waiting to be ` +
          `activated. Until it is, payments still go to the old account — which ` +
          `the relationship has already moved away from.`,
      });
    } else if (!s.oldKeyAttested) {
      findings.push({
        code: "PROPOSAL_WAITING_OLD_KEY",
        severity: "watch",
        detail:
          `A move to ${short(s.to)} is waiting on ${missing.join(" and ")}. ` +
          `Proposed moves that stall here are normal; proposed moves that stall ` +
          `here while invoices arrive naming the new account are the attack.`,
      });
    } else {
      findings.push({
        code: "PROPOSAL_WAITING_PAYER",
        severity: "watch",
        detail:
          `A move to ${short(s.to)} has the old key's agreement and is waiting on ` +
          `the business. If nobody on your side remembers agreeing to look at ` +
          `this, find out who proposed it.`,
      });
    }
  }

  return findings;
}

function nameOf(cp: WatchedCounterparty): string {
  return cp.displayName || cp.canonicalName || cp.id.slice(0, 18) + "…";
}

function short(a: string): string {
  return a && a.length > 14 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a;
}

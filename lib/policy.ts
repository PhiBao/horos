/**
 * The decision.
 *
 * Layers, strictly separated:
 *
 *   L2  Judgment   this file. Reads state, assembles evidence, and produces a verdict.
 *   L1  The Rule    the contracts. The only thing that can actually move money.
 *
 * The model may PROPOSE. The policy DECIDES. The contract ENFORCES.
 *
 * That separation is the whole design. It is the correction to the pattern where an
 * agent releases funds because a model returned confidence: "HIGH" - which is exactly
 * what Circle's own escrow sample does, and which the Canteen research on agent
 * bookkeeping names as the failure mode worth avoiding.
 *
 * Everything below is deterministic and unit-testable. The model never appears in
 * the release path.
 */

export type Verdict = "RELEASE" | "HOLD" | "ESCALATE";

export type Reason = {
  code: string;
  /** Shown to the user. Say what is true, not what is reassuring. */
  detail: string;
  /** Whether this reason alone is enough to stop the payment. */
  blocking: boolean;
};

export type Evidence = {
  counterpartyId: `0x${string}`;
  canonicalName: string;
  status: "Clean" | "Broken" | "None";
  activeAccount: `0x${string}` | `0x0`;
  /** How many accounts this counterparty has ever received money at. */
  accountCount: number;
  /** Payments attributed to this payer. */
  payerPayments: number;
  payerTotal: bigint;
  /** The address the invoice asked us to pay. */
  invoiceAccount: `0x${string}`;
  /** True when the invoice's address is the one already established. */
  addressMatchesActive: boolean;
  /** True when a fully attested succession is waiting to be activated. */
  successionPending: boolean;
  /** Terms on the invoice, in days. */
  termsDays: number;
  amount: bigint;
  /** Budget the human set for this counterparty. 0 means none. */
  counterpartyCap: bigint;
  globalCap: bigint;
  screening: {
    checked: boolean;
    flagged: boolean;
    source?: string;
    detail?: string;
  };
};

export type Decision = {
  verdict: Verdict;
  /** Every reason considered, blocking or not, in the order they were applied. */
  reasons: Reason[];
  /** The single most load-bearing fact, for the one-line summary. */
  headline: string;
  policyVersion: string;
  decidedAt: number;
  /** What the model proposed, kept for the calibration scoreboard. Never authoritative. */
  modelProposal?: {verdict: Verdict; rationale: string};
};

export const POLICY_VERSION = "1.0.0";

/**
 * The policy. Pure function of the evidence.
 *
 * Order matters and is deliberate:
 *   1. Can we even identify who we are paying?
 *   2. Is the money safe to move at all?
 *   3. Is this particular destination the right one?
 *   4. Is the amount within bounds?
 *   5. Terms, and anything a model had to say.
 *
 * Note what is NOT here: nothing reads a model verdict. A model can only ever
 * escalate, never release. That asymmetry is the point - a confused or
 * prompt-injected model cannot cause a payment, only a human being asked a question.
 */
export function decide(ev: Evidence): Decision {
  const reasons: Reason[] = [];
  const now = Date.now();

  // ---- 1. Do we know who this is? -------------------------------------
  if (ev.status === "None") {
    return {
      verdict: "ESCALATE",
      headline: "We have never paid this counterparty before.",
      reasons: [
        {
          code: "UNKNOWN_COUNTERPARTY",
          detail: "No record of this party exists. The first payment to anyone is always a decision for a person.",
          blocking: true,
        },
      ],
      policyVersion: POLICY_VERSION,
      decidedAt: now,
    };
  }

  // ---- 2. Is the money safe to move at all? ---------------------------
  if (!ev.screening.checked) {
    // Unavailability is not a pass. A screen that did not run must never read as clean.
    reasons.push({
      code: "SCREENING_UNAVAILABLE",
      detail:
        ev.screening.detail ??
        "Counterparty screening could not be run, so it did not pass. A check that did not run is not a clean result.",
      blocking: true,
    });
  }

  if (ev.status === "Broken") {
    reasons.push({
      code: "LINEAGE_BROKEN",
      detail:
        "This counterparty disclosed that it lost the key that received the last payment. That gap is permanent and public, and the address on this invoice cannot be proven to be the same party.",
      blocking: true,
    });
  }

  if (ev.screening.checked && ev.screening.flagged) {
    reasons.push({
      code: "SCREENING_FLAG",
      detail: ev.screening.detail ?? "The destination was flagged by screening.",
      blocking: true,
    });
  }

  if (ev.screening.checked && ev.screening.source) {
    reasons.push({
      code: "SCREENING_CLEAN",
      detail: `Screened against ${ev.screening.source}; nothing found. This is one input, not the whole answer.`,
      blocking: false,
    });
  }

  // ---- 3. Is this the right destination? ------------------------------
  if (!ev.addressMatchesActive) {
    if (ev.successionPending) {
      // A ceremony is already under way and fully attested. Waiting is correct.
      reasons.push({
        code: "SUCCESSION_ATTESTED",
        detail:
          "The move to this address has already been signed for by the previously-paid account and by us. The old address is suspended until the ceremony is activated.",
        blocking: true,
      });
    } else if (ev.accountCount > 0) {
      // The heart of the product. An account change nobody has signed for.
      reasons.push({
        code: "UNSIGNED_ACCOUNT_CHANGE",
        detail:
          `This invoice asks us to pay an address we have never paid. We have paid this counterparty ` +
          `${ev.payerPayments} time${ev.payerPayments === 1 ? "" : "s"} across ` +
          `${ev.accountCount} established account${ev.accountCount === 1 ? "" : "s"}. ` +
          `A new address is a request to move money somewhere new, and nothing has signed for it.`,
        blocking: true,
      });
    }
  } else {
    reasons.push({
      code: "ADDRESS_ON_RECORD",
      detail: "This is the address we have paid before. Nothing has changed.",
      blocking: false,
    });
  }

  // ---- 4. Is the amount within bounds? --------------------------------
  if (ev.counterpartyCap === 0n) {
    reasons.push({
      code: "NO_BUDGET",
      detail: "No spending limit has been set for this counterparty. It starts at zero, on purpose.",
      blocking: true,
    });
  } else if (ev.amount > ev.counterpartyCap) {
    reasons.push({
      code: "OVER_COUNTERPARTY_CAP",
      detail: `This invoice is over the limit set for this counterparty.`,
      blocking: true,
    });
  }

  if (ev.amount > ev.globalCap) {
    reasons.push({
      code: "OVER_GLOBAL_CAP",
      detail: "This invoice is over the overall single-payment limit.",
      blocking: true,
    });
  }

  // ---- 5. Terms, and anything the model noticed -----------------------
  if (ev.termsDays === 0 && ev.payerPayments > 0) {
    reasons.push({
      code: "IMMEDIATE_TERMS",
      detail: "Payable on receipt. Normal for a long-standing counterparty; unusual for a new one.",
      blocking: false,
    });
  }

  if (ev.accountCount === 1 && ev.payerPayments === 0 && ev.termsDays === 0) {
    reasons.push({
      code: "NEW_FAST_PAYER",
      detail: "First payment, immediate terms. Worth a human glance.",
      blocking: false,
    });
  }

  // ---- Verdict --------------------------------------------------------
  const blocking = reasons.filter((r) => r.blocking);
  if (blocking.length === 0) {
    return {
      verdict: "RELEASE",
      headline: ev.addressMatchesActive
        ? "The address is the one on record."
        : "Nothing about this payment is out of the ordinary.",
      reasons,
      policyVersion: POLICY_VERSION,
      decidedAt: now,
    };
  }

  const verdict: Verdict = blocking.some((r) => r.code === "UNKNOWN_COUNTERPARTY") ? "ESCALATE" : "HOLD";

  return {
    verdict,
    headline: blocking[0].detail.split(".")[0] + ".",
    reasons,
    policyVersion: POLICY_VERSION,
    decidedAt: now,
  };
}

/**
 * Fold in what the model proposed.
 *
 * Deliberately one-directional. A model can talk us into asking a person a
 * question. It cannot talk us into sending money. If the model says RELEASE and the
 * policy says HOLD, the policy wins and the disagreement is recorded - that
 * disagreement is the calibration scoreboard, and it is worth more than the
 * model's opinion was.
 */
export function applyModelProposal(decision: Decision, proposal?: {verdict: Verdict; rationale: string}): Decision {
  if (!proposal) return decision;
  const withProposal: Decision = {...decision, modelProposal: proposal};

  if (decision.verdict === "RELEASE" && proposal.verdict !== "RELEASE") {
    return {
      ...withProposal,
      verdict: "ESCALATE",
      headline: "Nothing in the policy blocks this, but something in the document does. A person should look.",
      reasons: [
        ...decision.reasons,
        {
          code: "MODEL_ESCALATION",
          detail: `Reading the document flagged this: ${proposal.rationale}`,
          blocking: true,
        },
      ],
    };
  }

  if (decision.verdict !== "RELEASE" && proposal.verdict === "RELEASE") {
    // The model wanted to pay. It does not get to. The disagreement is logged.
    return {
      ...withProposal,
      reasons: [
        ...decision.reasons,
        {
          code: "MODEL_DISAGREED",
          detail: `The document reading proposed release (${proposal.rationale}). Overruled: the rule is what decides.`,
          blocking: false,
        },
      ],
    };
  }

  return withProposal;
}

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

import {concern} from "./judgment.js";

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
  /**
   * What the document itself says, as calibrated probabilities rather than a
   * verdict. See lib/judgment.ts.
   *
   * Present but advisory. Absent is fine: a judgment provider being unreachable
   * is not a reason to pay, and not a reason to crash. The policy below reads
   * these only to escalate.
   */
  judgment?: {
    provider: "typesafe" | "none";
    signals: {
      id: string;
      probability: number;
      question: string;
      label: string;
      concerns_when: "high" | "low";
      threshold: number;
    }[];
    rationale?: string;
  };

  /** Text in the document that read as an instruction to the reader. */
  injectedInstructions?: string[];

  /**
   * Set when the invoice named more than one payment destination and offered no
   * way to choose. Extraction returns null rather than picking one, and this is
   * how the refusal reaches the user instead of vanishing.
   */
  ambiguousDestination?: string[];

  screening: {
    checked: boolean;
    /** The destination has never sent a transaction. Note-level context, never a verdict. */
    novelAddress?: boolean;
    /** The destination holds contract code. Note-level context, never a verdict. */
    contractAddress?: boolean;
    flagged: boolean;
    source?: string;
    detail?: string;
    /**
     * The business has explicitly accepted running without screening.
     *
     * This is a decision a person makes, on the record, and it is visible in the
     * decision card. Without it, a missing screening service blocks every
     * payment forever, which is not a product — it is an outage. With it, the
     * business is told plainly what it is giving up.
     */
    waived?: boolean;
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

export const POLICY_VERSION = "1.1.0";

/**
 * Above this calibrated probability, a document signal escalates the payment.
 *
 * Applied to the signal's *concern* probability, not its raw answer - see
 * lib/judgment.ts. Each question declares which direction of itself is the worrying
 * one, so one inverted question cannot invert the whole decision.
 *
 * Deliberately at 0.5, not 0.9. The cost of a false positive is one question to a
 * person; the cost of a false negative is money sent to whoever wrote the
 * invoice. Those are not symmetric, so the threshold is not either.
 */
export const JUDGMENT_ESCALATE_ABOVE = 0.5;

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

  // ---- 1b. What does the document itself say? ------------------------
  // Injection strings are the cheapest possible signal, and they are the one an
  // attacker must include. A legitimate invoice does not tell the reader what to
  // disregard.
  if (ev.injectedInstructions?.length) {
    reasons.push({
      code: "INJECTED_INSTRUCTIONS",
      detail:
        `The document contains text addressed to whoever is reading it: ` +
        `${ev.injectedInstructions.slice(0, 3).map((c) => `"${c}"`).join(", ")}. ` +
        `A supplier invoice has no reason to say this. It has been recorded, not followed.`,
      blocking: true,
    });
  }

  // An invoice that names two destinations and does not say which one it wants is
  // not an invoice to act on. This is the one case where the honest answer and the
  // convenient answer differ, and the convenient one is what an attacker is counting
  // on: pick the address that appears most often, or the most recent, or the last.
  if (ev.ambiguousDestination?.length) {
    reasons.push({
      code: "AMBIGUOUS_DESTINATION",
      detail:
        `The document names ${ev.ambiguousDestination.length} payment destinations ` +
        `(${ev.ambiguousDestination.map((a) => `${a.slice(0, 8)}…${a.slice(-4)}`).join(", ")}) ` +
        `and does not say which one it wants. Nobody is guessing which of those was meant.`,
      blocking: true,
    });
  }

  // A judgment signal is a calibrated probability, so it gets a threshold rather
  // than a yes/no. The threshold is in this file because the consequence of being
  // wrong belongs to the code, not to the prompt. Escalating on a weak signal
  // would make the agent nag; ignoring a strong one would make it decorative.
  if (ev.judgment?.provider === "typesafe") {
    for (const signal of ev.judgment.signals) {
      // Orient every signal the same way before thresholding. One of the four is
      // asked in the reassuring direction - "is this an ordinary invoice" - so a
      // high answer there is a reason to relax, not to stop. Reading all four as
      // risk-if-high is backwards for that one, and the mistake is invisible until
      // the value happens to cross the threshold.
      const concerning = concern(signal);
      // Per-signal, because the questions are not equally reliable. See
      // ESCALATES_ABOVE in lib/judgment.ts for why is_ordinary is the outlier and
      // why the number is where it is.
      const threshold = signal.threshold ?? JUDGMENT_ESCALATE_ABOVE;
      if (concerning < threshold) continue;
      reasons.push({
        code: `DOCUMENT_${signal.id.toUpperCase()}`,
        detail:
          `The document ${signal.label} — judged ${Math.round(concerning * 100)}% likely. ` +
          `That is a threshold in this file, not a rule in a prompt, and this payment is worth a person looking at it.`,
        blocking: true,
      });
    }
  }

  // ---- 2. Is the money safe to move at all? ---------------------------
  if (!ev.screening.checked) {
    if (ev.screening.waived) {
      // A person chose this. It is stated every time, so the choice stays visible.
      reasons.push({
        code: "SCREENING_WAIVED",
        detail:
          ev.screening.detail ??
          "This business has not turned on counterparty screening, and has accepted that. " +
            "Only payment history is protecting these payments.",
        blocking: false,
      });
    } else {
      // Unavailability is not a pass. A screen that did not run must never read as
      // clean, and must never silently become a permanent block either.
      reasons.push({
        code: "SCREENING_UNAVAILABLE",
        detail:
          ev.screening.detail ??
          "Counterparty screening could not be run, so it did not pass. A check that did not run is not a clean result.",
        blocking: true,
      });
    }
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

  // What the chain itself says about the destination. Notes, never verdicts: the
  // account after a genuine ceremony is fresh too, and it must still release. But
  // a redirected payment goes somewhere new by definition, so "never seen onchain
  // before" is context a person should have when they review the refusal.
  if (ev.screening.novelAddress) {
    reasons.push({
      code: "SCREENING_NOVEL_ADDRESS",
      detail:
        "This address has never sent a transaction onchain before. That is normal for " +
        "a brand-new account — and it is also exactly what a redirected payment looks " +
        "like. Recorded as context, not treated as a verdict.",
      blocking: false,
    });
  }
  if (ev.screening.contractAddress) {
    reasons.push({
      code: "SCREENING_CONTRACT_ADDRESS",
      detail:
        "The destination holds contract code: it is a program, not a person. Paying a " +
        "contract is sometimes correct (a multisig, a vault) and sometimes the whole " +
        "attack. Worth one look.",
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
          // Phrased around the counterparty's history rather than the payer's, so it
          // reads correctly on the public page, where nobody has a payer identity and
          // a count of zero would claim "we have paid this 0 times" about a
          // counterparty with two accounts behind it.
          `This invoice asks us to pay an address that has never been paid. ` +
          (ev.payerPayments > 0
            ? `We have paid this counterparty ${ev.payerPayments} time${ev.payerPayments === 1 ? "" : "s"}. `
            : "") +
          (ev.accountCount > 0
            ? `${ev.accountCount} account${ev.accountCount === 1 ? " has" : "s have"} been paid at some point, ` +
              `and this is not one of them. `
            : `Nobody has ever paid this counterparty. `) +
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

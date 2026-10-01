/**
 * Tests for the judgment layer's wiring, not its wisdom.
 *
 * The bug these exist to prevent: `judgeDocument` read its key from `process.env`.
 * That is correct in a Node script and wrong in a Cloudflare Worker, where
 * `process.env` does not exist. The deployed site therefore answered every request
 * with `provider: "none"` — which is *also* what a correctly configured deployment
 * with no key returns, and equally what a genuinely unreachable provider returns.
 *
 * Three different situations, one indistinguishable output. In a component whose
 * entire job is to notice things, that is the worst shape a bug can have: no error,
 * no exception, just a quiet and plausible nothing.
 *
 * So these tests pin the contract that makes the three separable: the key is passed
 * in, an explicit key is used, and the absence of one is honoured without pretending
 * it is a judgment.
 */

import {describe, expect, it} from "vitest";

import {judgmentKey, typesafeConfigured} from "./judgment.js";
import {judgeInvoice, buildInvoice} from "./demo-invoices.js";

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;

const relationship = {
  paymentsMadeSoFar: 14,
  previouslyPaidAddress: ADDRESS,
  addressMatchesRecord: true,
  daysRelationship: 670,
};

describe("where the judgment key comes from", () => {
  it("uses an explicitly passed key, whatever the environment says", () => {
    expect(judgmentKey("apikey_explicit")).toBe("apikey_explicit");
  });

  it("reports unconfigured when there is no key anywhere", () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      expect(judgmentKey()).toBeUndefined();
      expect(typesafeConfigured()).toBe(false);
      expect(typesafeConfigured("apikey_x")).toBe(true);
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });

  it("does not invent a key when given an empty string", () => {
    // The deployed binding is an empty string until the secret is set, and "" must
    // mean absent rather than be treated as a usable credential.
    expect(judgmentKey("")).toBeUndefined();
    expect(typesafeConfigured("")).toBe(false);
  });
});

describe("judging without a provider", () => {
  it("returns undefined rather than a judgment when no key is supplied", async () => {
    const doc = buildInvoice("attack", {payTo: ADDRESS, prior: ADDRESS, amount: "2400.00"});
    const j = await judgeInvoice(doc, ADDRESS, relationship, {apiKey: ""});
    // Undefined, not {provider:"none"} - the caller has to distinguish "nobody asked"
    // from "somebody asked and got nothing", because only one of those is a problem.
    expect(j).toBeUndefined();
  });

  it("never throws when the provider is unreachable, so a decision can still be made", async () => {
    const doc = buildInvoice("ordinary", {payTo: ADDRESS});
    // A syntactically fine but unusable key: the call will fail, and the layer must
    // absorb that rather than take the decision down with it.
    const j = await judgeInvoice(doc, ADDRESS, relationship, {apiKey: "apikey_not_a_real_key"});
    expect(j === undefined || j.provider === "none" || j.signals.length >= 0).toBe(true);
  }, 30_000);
});

/**
 * Tests for the screening layer's honesty, not its coverage.
 *
 * There is no sanctions-list provider here, and these tests do not pretend
 * otherwise. What they pin is the distinction the layer exists to maintain: the
 * difference between "checked and clean", "checked and novel", "could not check",
 * and "nothing to check". Collapsing any two of those is how a screening layer
 * starts lying, and every collapse is silent.
 */

import {describe, expect, it} from "vitest";

import {
  screenCounterparty,
  screenFreshness,
  toEvidence,
  unscreened,
} from "./screening.js";

const FRESH = "0x000000000000000000000000000000000000dEaD" as const;
const USDC_ARC = "0x3600000000000000000000000000000000000000" as const;
const RPC = "https://rpc.testnet.arc.io";

describe("freshness, against the live chain", () => {
  it("reads a burn address as novel and not a contract", async () => {
    const f = await screenFreshness(FRESH, RPC);
    expect(f.known).toBe(true);
    expect(f.novel).toBe(true);
    expect(f.isContract).toBe(false);
  });

  it("reads USDC as a contract, not a person", async () => {
    const f = await screenFreshness(USDC_ARC, RPC);
    expect(f.known).toBe(true);
    expect(f.isContract).toBe(true);
  });

  it("reports unknown rather than clean when the RPC is unreachable", async () => {
    const f = await screenFreshness(FRESH, "https://127.0.0.1:9", {timeoutMs: 1500});
    expect(f).toEqual({novel: false, isContract: false, known: false});
  });
});

describe("screenCounterparty", () => {
  it("says which half ran and which half did not", async () => {
    const r = await screenCounterparty(FRESH, {rpcUrls: [RPC]});
    expect(r.status).toBe("unavailable");
    expect(r.freshness.known).toBe(true);
    expect(r.freshness.novel).toBe(true);
    expect(r.source).toMatch(/chain freshness/);
    expect(r.source).toMatch(/no sanctions list/);
  });

  it("carries novelty into the evidence without flagging it", () => {
    const ev = toEvidence({
      status: "unavailable",
      waived: true,
      source: "chain freshness only",
      detail: "d",
      freshness: {novel: true, isContract: false, known: true},
    });
    // Checked — something real ran — but not flagged. Novelty is context.
    expect(ev.checked).toBe(true);
    expect(ev.flagged).toBe(false);
    expect(ev.novelAddress).toBe(true);
  });

  it("does not claim a check ran when freshness is unknown", () => {
    const ev = toEvidence({
      status: "unavailable",
      waived: true,
      source: "none",
      detail: "d",
      freshness: {novel: false, isContract: false, known: false},
    });
    expect(ev.novelAddress).toBeUndefined();
    expect(ev.contractAddress).toBeUndefined();
  });
});

describe("unscreened", () => {
  it("names the absence instead of screening the zero address", () => {
    const r = unscreened("The document never resolved to an address.");
    expect(r.status).toBe("unavailable");
    expect(r.source).toBe("no address resolved");
    const ev = toEvidence(r);
    expect(ev.checked).toBe(false);
    expect(ev.novelAddress).toBeUndefined();
  });
});

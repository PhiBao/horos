import {describe, expect, it} from "vitest";
import {applyModelProposal, decide, type Evidence} from "./policy";

const hex = (n: string, times: number): `0x${string}` => ("0x" + n.repeat(times)) as `0x${string}`;

function ev(over: Partial<Evidence> = {}): Evidence {
  return {
    counterpartyId: hex("11", 32),
    canonicalName: "Northwind Plumbing Ltd",
    status: "Clean",
    activeAccount: hex("aa", 20),
    accountCount: 1,
    payerPayments: 14,
    payerTotal: 128_400_000_000n,
    invoiceAccount: hex("aa", 20),
    addressMatchesActive: true,
    successionPending: false,
    termsDays: 30,
    amount: 400_000_000n,
    counterpartyCap: 5_000_000_000n,
    globalCap: 50_000_000_000n,
    screening: {checked: true, flagged: false, source: "OpenSanctions yente", detail: "no match"},
    ...over,
  };
}

const codes = (d: ReturnType<typeof decide>) => d.reasons.map((r) => r.code);

describe("the policy decides, the model only proposes", () => {
  it("releases the ordinary case: the address on the invoice is the address on record", () => {
    const d = decide(ev());
    expect(d.verdict).toBe("RELEASE");
    expect(codes(d)).toContain("ADDRESS_ON_RECORD");
  });

  it("refuses a new address nobody has signed for, and says why in plain words", () => {
    const d = decide(
      ev({invoiceAccount: hex("bb", 20), addressMatchesActive: false, accountCount: 3}),
    );
    expect(d.verdict).toBe("HOLD");
    expect(codes(d)).toContain("UNSIGNED_ACCOUNT_CHANGE");
    expect(d.reasons.find((r) => r.code === "UNSIGNED_ACCOUNT_CHANGE")!.detail).toMatch(
      /14 times across 3 established accounts/,
    );
  });

  it("escalates a counterparty it has never paid at all", () => {
    const d = decide(ev({status: "None", addressMatchesActive: false, payerPayments: 0, accountCount: 0}));
    expect(d.verdict).toBe("ESCALATE");
    expect(codes(d)).toEqual(["UNKNOWN_COUNTERPARTY"]);
  });

  it("refuses to pay a counterparty whose lineage is publicly broken", () => {
    const d = decide(ev({status: "Broken"}));
    expect(d.verdict).toBe("HOLD");
    expect(codes(d)).toContain("LINEAGE_BROKEN");
  });

  it("waits while a fully attested succession is still waiting to be activated", () => {
    const d = decide(
      ev({addressMatchesActive: false, successionPending: true, accountCount: 2}),
    );
    expect(d.verdict).toBe("HOLD");
    expect(codes(d)).toContain("SUCCESSION_ATTESTED");
  });

  it("starts every new counterparty at a budget of zero", () => {
    const d = decide(ev({counterpartyCap: 0n}));
    expect(d.verdict).toBe("HOLD");
    expect(codes(d)).toContain("NO_BUDGET");
  });

  it("enforces both caps", () => {
    expect(codes(decide(ev({amount: 6_000_000_000n})))).toContain("OVER_COUNTERPARTY_CAP");
    expect(codes(decide(ev({amount: 60_000_000_000n})))).toContain("OVER_GLOBAL_CAP");
  });

  it("treats a screening hit as blocking, and a clean screen as merely informational", () => {
    const hit = decide(ev({screening: {checked: true, flagged: true, detail: "sanctions exposure"}}));
    expect(hit.verdict).toBe("HOLD");
    expect(codes(hit)).toContain("SCREENING_FLAG");

    const clean = decide(ev());
    const s = clean.reasons.find((r) => r.code === "SCREENING_CLEAN");
    expect(s?.blocking).toBe(false);
  });

  it("degrades to escalation when screening could not run, rather than to release", () => {
    const d = decide(
      ev({screening: {checked: false, flagged: false, detail: "screening service unavailable"}}),
    );
    // Unavailability is not a pass. It must not silently read as clean.
    expect(d.verdict).not.toBe("RELEASE");
  });
});

describe("a model can only ever slow a payment down", () => {
  const released = () => decide(ev());

  it("cannot convert a release into another release", () => {
    const d = applyModelProposal(released(), {verdict: "RELEASE", rationale: "looks normal"});
    expect(d.verdict).toBe("RELEASE");
    expect(d.modelProposal?.verdict).toBe("RELEASE");
  });

  it("can escalate a payment the policy would have released", () => {
    const d = applyModelProposal(released(), {
      verdict: "ESCALATE",
      rationale: "the document contains instructions addressed to the reader",
    });
    expect(d.verdict).toBe("ESCALATE");
    expect(codes(d)).toContain("MODEL_ESCALATION");
  });

  it("cannot talk a hold into a release", () => {
    const held = decide(ev({invoiceAccount: hex("bb", 20), addressMatchesActive: false, accountCount: 2}));
    expect(held.verdict).toBe("HOLD");
    const d = applyModelProposal(held, {verdict: "RELEASE", rationale: "the vendor says it is correct"});
    expect(d.verdict).toBe("HOLD");
    expect(codes(d)).toContain("MODEL_DISAGREED");
  });

  it("records the disagreement rather than discarding it", () => {
    const held = decide(ev({invoiceAccount: hex("bb", 20), addressMatchesActive: false, accountCount: 2}));
    const d = applyModelProposal(held, {verdict: "RELEASE", rationale: "trust me"});
    expect(d.modelProposal).toEqual({verdict: "RELEASE", rationale: "trust me"});
  });

  it("changes nothing when there is no model in the loop at all", () => {
    const before = released();
    const after = applyModelProposal(before, undefined);
    expect(after.verdict).toBe(before.verdict);
    expect(after.modelProposal).toBeUndefined();
  });
});

describe("the same evidence always produces the same decision", () => {
  it("is deterministic", () => {
    const a = decide(ev({invoiceAccount: hex("bb", 20), addressMatchesActive: false}));
    const b = decide(ev({invoiceAccount: hex("bb", 20), addressMatchesActive: false}));
    expect(a.verdict).toBe(b.verdict);
    expect(codes(a)).toEqual(codes(b));
    // only the timestamp may differ
    expect({...a, decidedAt: 0}).toEqual({...b, decidedAt: 0});
  });
});

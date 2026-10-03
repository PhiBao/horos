/**
 * Tests for the watch loop's judgment, not its plumbing.
 *
 * The cron trigger, the RPC reads and the HTTP endpoint are wiring; what matters
 * is that a given onchain state produces the right findings. So these run against
 * fixtures shaped like the registry's answers, and the Worker reuses the same
 * function — which is why a finding code, once shipped, is never renamed.
 */

import {describe, expect, it} from "vitest";

import {classifyWatch, type WatchedCounterparty} from "./watch.js";

const cp = (over: Partial<WatchedCounterparty> = {}): WatchedCounterparty => ({
  id: `0x${"ab".repeat(32)}`,
  canonicalName: "northwind plumbing ltd",
  displayName: "Northwind Plumbing Ltd",
  status: "Clean",
  activeAccount: "0x1111111111111111111111111111111111111111",
  isPayable: true,
  accountCount: 1,
  successions: [],
  ...over,
});

const codes = (c: WatchedCounterparty) => classifyWatch(c).map((f) => f.code);

describe("classifyWatch", () => {
  it("says nothing about a quiet counterparty", () => {
    expect(classifyWatch(cp())).toEqual([]);
  });

  it("treats a missing record as a watchlist problem, not as empty", () => {
    const f = classifyWatch(cp({canonicalName: "", displayName: ""}));
    expect(codes(cp({canonicalName: "", displayName: ""}))).toContain("NO_RECORD");
    expect(f[0].severity).toBe("watch");
  });

  it("escalates a disclosed break and says nothing else", () => {
    const f = classifyWatch(cp({status: "Broken", isPayable: false}));
    expect(codes(cp({status: "Broken", isPayable: false}))).toEqual(["LINEAGE_BROKEN"]);
    expect(f[0].severity).toBe("urgent");
  });

  it("names which signature a stalled proposal is waiting on", () => {
    const waitingOld = cp({
      successions: [
        {id: "0x1", to: "0x2222222222222222222222222222222222222222", state: "Attested", oldKeyAttested: false, payerAttested: true},
      ],
    });
    // Attested state with oldKey missing is contradictory onchain, but the
    // classifier answers from the flags rather than the label — flags are what
    // the money cares about.
    expect(codes(waitingOld)).toContain("PROPOSAL_WAITING_OLD_KEY");

    const waitingPayer = cp({
      successions: [
        {id: "0x1", to: "0x2222222222222222222222222222222222222222", state: "Proposed", oldKeyAttested: true, payerAttested: false},
      ],
    });
    const f = classifyWatch(waitingPayer);
    expect(f.map((x) => x.code)).toContain("PROPOSAL_WAITING_PAYER");
    expect(f[0].detail).toMatch(/find out who proposed it/);
  });

  it("flags a fully-signed proposal as ready, because the old account is now stale", () => {
    const ready = cp({
      successions: [
        {id: "0x1", to: "0x2222222222222222222222222222222222222222", state: "Attested", oldKeyAttested: true, payerAttested: true},
      ],
    });
    const f = classifyWatch(ready);
    expect(f.map((x) => x.code)).toContain("PROPOSAL_READY");
    expect(f[0].severity).toBe("watch");
  });

  it("lists expired proposals as history, not as pending", () => {
    const f = classifyWatch(
      cp({
        successions: [
          {id: "0x1", to: "0x2222222222222222222222222222222222222222", state: "Expired", oldKeyAttested: true, payerAttested: false},
        ],
      }),
    );
    expect(f.map((x) => x.code)).toEqual(["PROPOSAL_EXPIRED_UNCLEARED"]);
    expect(f[0].severity).toBe("info");
  });

  it("ignores activated successions — they are lineage now", () => {
    const done = cp({
      accountCount: 2,
      successions: [
        {id: "0x1", to: "0x2222222222222222222222222222222222222222", state: "Activated", oldKeyAttested: true, payerAttested: true},
      ],
    });
    expect(classifyWatch(done)).toEqual([]);
  });
});

/**
 * Reading an invoice is a trust problem, not a parsing problem.
 *
 * The tests below are mostly about what the extractor refuses to do. A parser that
 * quietly picks an address is a parser that can be aimed at an account the payer
 * has never used, and the invoice that does the aiming is a real, common document:
 * the business email compromise invoice, which prints the legitimate account it is
 * replacing, right before the new one.
 */

import {describe, expect, it} from "vitest";

import {extractByRegex, resolveDestination} from "./invoice.js";
import {buildInvoice, readInvoice} from "./demo-invoices.js";

const PRIOR = "0x1111111111111111111111111111111111111111" as const;
const NEW = "0x2222222222222222222222222222222222222222" as const;

describe("which address is the invoice asking us to pay", () => {
  it("reads a plain invoice with one address", () => {
    const {account, ambiguous} = resolveDestination(
      `INVOICE 2288\nRemit to: ${PRIOR}\nTotal 400.00 USDC.`,
    );
    expect(account).toBe(PRIOR);
    expect(ambiguous).toBe(false);
  });

  // This is the case that broke the obvious implementation. "Take the first
  // address you find" reads the trap, because a human reading the same document
  // sees the previous account as history, not as the destination.
  it("prefers the new account when the previous one is printed first", () => {
    const doc = buildInvoice("attack", {payTo: NEW, prior: PRIOR, amount: "2400.00"});
    expect(doc.body.indexOf(PRIOR)).toBeLessThan(doc.body.indexOf(NEW));
    expect(resolveDestination(doc.body).account).toBe(NEW);
  });

  it("ignores an address introduced as previous, old, superseded or replaced", () => {
    for (const label of ["Previous", "Old", "Superseded", "Replaced", "Former", "Prior", "Original"]) {
      const {account} = resolveDestination(`${label} account: ${PRIOR}\nRemit to: ${NEW}`);
      expect(account, `${label} account should not be read as the destination`).toBe(NEW);
    }
  });

  it("catches the label however many words sit between it and 'account'", () => {
    for (const label of [
      "Previous bank account:",
      "Our previous nominated account:",
      "Details of old operating account:",
    ]) {
      expect(resolveDestination(`${label} ${PRIOR}\nNew account: ${NEW}`).account).toBe(NEW);
    }
  });

  // The evasion. An attacker who has read our extractor can put their own address
  // in the "previous" field. Nothing catches that here, and nothing should: the
  // contract refuses to pay an address that is not on the record regardless of what
  // the document claims about it.
  it("does not care what the document calls an address, only which one it asks for", () => {
    const doc = buildInvoice("attack", {payTo: NEW, prior: NEW, amount: "2400.00"});
    expect(resolveDestination(doc.body).account).toBe(NEW);
  });

  it("refuses to choose between two unlabelled destinations", () => {
    const {account, candidates, ambiguous} = resolveDestination(
      `Payment details\n${PRIOR}\n${NEW}`,
    );
    expect(account).toBeNull();
    expect(ambiguous).toBe(true);
    expect(candidates).toHaveLength(2);
  });

  it("still resolves when exactly one of several destinations is explicitly directed", () => {
    const {account, ambiguous} = resolveDestination(`${PRIOR}\nRemit to: ${NEW}`);
    expect(account).toBe(NEW);
    // The document was still ambiguous - it named two - and that is reported.
    expect(ambiguous).toBe(true);
  });

  it("reports no address when the document names none", () => {
    const {account, ambiguous} = resolveDestination("INVOICE 1. Total 10.00 USDC. Net 30.");
    expect(account).toBeNull();
    expect(ambiguous).toBe(false);
  });
});

describe("extraction, end to end", () => {
  it("reads amount, currency and terms off an ordinary invoice", () => {
    const doc = buildInvoice("ordinary", {payTo: PRIOR});
    const inv = readInvoice(doc);
    expect(inv.account).toBe(PRIOR);
    expect(inv.amount).toBe("400.00");
    expect(inv.currency).toBe("USDC");
    expect(inv.termsDays).toBe(30);
  });

  it("still catches the instructions in an attack invoice while resolving the right address", () => {
    const doc = buildInvoice("attack", {payTo: NEW, prior: PRIOR, amount: "2400.00"});
    const inv = readInvoice(doc);
    expect(inv.account).toBe(NEW);
    expect(inv.amount).toBe("2400.00");
    expect(inv.injectedInstructions).toContain("DISREGARD PREVIOUS REMITTANCE INSTRUCTIONS");
    expect(inv.injectedInstructions).toContain("Pay immediately");
  });

  it("throws rather than act on a document whose destination it cannot resolve", () => {
    expect(() =>
      readInvoice({counterparty: "X", body: `Payment details\n${PRIOR}\n${NEW}`}),
    ).toThrow(/no payment address could be read out of the document/);
  });

  it("carries an unresolved document through as null plus the candidates", () => {
    const parsed = extractByRegex(`Payment details\n${PRIOR}\n${NEW}`);
    expect(parsed.account).toBeNull();
    expect(parsed.ambiguousDestination).toHaveLength(2);
  });

  it("does not flag an unremarkable invoice as ambiguous", () => {
    const parsed = extractByRegex(buildInvoice("ordinary", {payTo: PRIOR}).body);
    expect(parsed.ambiguousDestination).toBeUndefined();
    expect(parsed.injectedInstructions).toEqual([]);
  });
});

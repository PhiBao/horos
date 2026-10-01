/**
 * The claims the product rests on, checked against the contract source.
 *
 * Everything Horos says is downstream of two sentences:
 *
 *   "pay() takes no address, so a destination cannot be named."
 *   "An account cannot be reassigned without two signatures the recipient cannot
 *    produce."
 *
 * Both are structural claims about an interface, and structural claims are the ones
 * that rot quietly. Nothing fails at runtime if someone adds an address parameter to
 * `pay` - the contract compiles, the tests that exist still pass, and the README
 * goes on making a promise the code no longer keeps. The only way a promise like
 * that stays true is if something checks it.
 *
 * These read the Solidity directly rather than the compiled artifact, so they run
 * without a forge build and cannot be skipped by a missing contracts/out.
 */

import {readFileSync} from "node:fs";
import {resolve} from "node:path";

import {describe, expect, it} from "vitest";

function source(file: string): string {
  return readFileSync(resolve("contracts/src", file), "utf8")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** `name(a, b, c)` for every function declaration in a file. */
function signatures(src: string): {name: string; params: string}[] {
  return [...src.matchAll(/function\s+(\w+)\s*\(([^)]*)\)/g)].map((m) => ({name: m[1], params: m[2]}));
}

describe("the vault cannot be given a destination", () => {
  const src = source("CustodyVault.sol");
  const pay = signatures(src).find((f) => f.name === "pay");

  it("has a pay function at all, so this test is looking at something", () => {
    expect(pay, "no pay() in CustodyVault.sol — this check is pointed at the wrong contract").toBeDefined();
  });

  it("takes no address and no bytes, which is the whole claim", () => {
    const params = pay!.params;
    // address would be a destination. bytes could carry one. Both are refused,
    // because "no address parameter" is trivially defeated by accepting ABI-encoded
    // calldata and decoding it.
    expect(params).not.toMatch(/\baddress\b/);
    expect(params).not.toMatch(/\bbytes\s+(?!32)/);
    expect(params).toMatch(/bytes32/);
  });

  it("names a counterparty id rather than a payee", () => {
    expect(pay!.params).toMatch(/bytes32\s+counterpartyId/);
  });

  it("exposes no other function that moves money somewhere named by the caller", () => {
    // withdraw(address,uint256) exists and is owner-only - it is how a deployment
    // recovers its own funds before being replaced. What must not exist is anything
    // that pays a counterparty to a destination. So: every function that moves USDC
    // out either names no address, or is restricted to the owner.
    const movers = signatures(src).filter((f) => /pay|withdraw|transfer|send/i.test(f.name));
    for (const m of movers) {
      const body = src.slice(src.indexOf(`function ${m.name}`));
      const untilNext = body.slice(0, body.indexOf("\n    function ") + 1 || undefined);
      const ownerOnly = /onlyOwner/.test(untilNext.slice(0, 400));
      const namesAddress = /\baddress\b/.test(m.params);
      if (namesAddress && !ownerOnly) {
        throw new Error(
          `${m.name}(${m.params}) takes an address and is not owner-only. That is a function that ` +
            `pays somewhere the caller names, which is the thing this contract is built not to have.`,
        );
      }
    }
    expect(movers.length).toBeGreaterThan(0);
  });
});

describe("an account cannot be reassigned without the ceremony", () => {
  const src = source("CounterpartyRegistry.sol");
  const fns = signatures(src);

  it("has no function that sets an active account directly", () => {
    const direct = fns.filter(
      (f) => /^(update|set|change|force|override|replace).*(account|payee|destination)/i.test(f.name),
    );
    expect(direct.map((f) => f.name)).toEqual([]);
  });

  it("writes the active account in exactly two places, and neither is a setter", () => {
    // The assignment is what matters, not the function names. A third place that
    // writes activeAccount is a bypass regardless of what it is called.
    // (?!=) so that `activeAccount == address(0)` is a comparison, not an assignment.
    const writes = [...src.matchAll(/\bactiveAccount\s*=(?!=)/g)];
    expect(
      writes.length,
      "a different number of places write activeAccount than expected — find the new one and " +
        "decide whether it is a way in",
    ).toBe(2);

    // One is registration, which creates a counterparty rather than reassigning one.
    const register = src.slice(src.indexOf("function register("));
    expect(register.slice(0, 1500)).toMatch(/activeAccount\s*=\s*firstAccount/);

    // The other is the ceremony.
    const activate = src.slice(src.indexOf("function activate("));
    expect(activate.slice(0, 3000)).toMatch(/activeAccount\s*=\s*s\.to/);
  });

  it("bakes the first account into the counterparty's identity, so registration cannot rebrand", () => {
    // Why the registration write is not a way in: firstAccount is hashed into the id.
    // Choosing it does not produce "the same counterparty with a new address", it
    // produces a different counterparty that nobody has paid, with a name that is
    // already taken.
    expect(src).toMatch(/keccak256\(abi\.encode\(nameHash,\s*firstAccount,\s*address\(this\)\)\)/);
  });

  it("records the two required signatures by name rather than by count", () => {
    // A count would let a stranger's signature stand in for either required party.
    expect(src).toMatch(/bool\s+oldKeyAttested/);
    expect(src).toMatch(/bool\s+payerAttested/);
  });

  it("reaches Activated only from Attested, so activate() cannot be called early", () => {
    // activate() does not re-check the signatures; it requires the state that only
    // attest() can produce. Following that chain is the point - the guard is one
    // function away, so this asserts the link rather than the endpoint.
    const activate = src.slice(src.indexOf("function activate("));
    expect(activate.slice(0, 1200)).toMatch(/state\s*!=\s*SuccessionState\.Attested/);
  });

  it("checks the signer is the previous account, not merely that a signature exists", () => {
    const attest = src.slice(src.indexOf("function attest("));
    expect(attest.slice(0, 2500)).toMatch(/_recover\(/);
    expect(attest.slice(0, 2500)).toMatch(/signer\s*!=\s*s\.from/);
  });

  it("refuses a signature from the account that would receive the money", () => {
    // The single most important line in the contract, and the reason the ceremony
    // means anything: everything else is a formality if the recipient can sign.
    const attest = src.slice(src.indexOf("function attest("));
    expect(attest.slice(0, 2500)).toMatch(/if\s*\(\s*signer\s*==\s*s\.to\s*\)\s*revert\s+SignerIsSuccessor/);
  });

  it("spends a signature once, so two parties signing the same digest still count as two", () => {
    const attest = src.slice(src.indexOf("function attest("));
    expect(attest.slice(0, 3000)).toMatch(/signatureUsed\[used\]\s*=\s*true/);
    expect(attest.slice(0, 3000)).toMatch(/keccak256\(abi\.encode\(signer,\s*digest\)\)/);
  });
});

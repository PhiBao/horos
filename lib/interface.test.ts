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

/**
 * The body of one function, up to the next declaration.
 *
 * Fixed-length slices were the first attempt and they broke the moment a function
 * grew: the assertion silently read past the end of the function it was checking and
 * failed for the wrong reason. Slicing to the next declaration cannot drift.
 */
export function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name} in this source`);
  const rest = src.slice(start + 1);
  const next = rest.indexOf("\n    function ");
  return next < 0 ? rest : rest.slice(0, next);
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

describe("the vault only lets named callers spend", () => {
  const src = source("CustodyVault.sol");

  it("checks the caller before it moves anything", () => {
    const pay = fnBody(src, "pay");
    expect(pay).toMatch(/if\s*\(\s*!executor\[msg\.sender\]\s*&&\s*msg\.sender\s*!=\s*owner\s*\)\s*revert\s+NotExecutor/);
  });

  it("lets only the owner name an executor", () => {
    const set = fnBody(src, "setExecutor");
    expect(set).toMatch(/onlyOwner/);
  });

  it("still takes no destination", () => {
    // The executor list must not have loosened the original property. Read the
    // parameter list, not the body: the return type is an address and matching the
    // body would flag the function's own return value.
    const pay = signatures(src).find((f) => f.name === "pay");
    expect(pay).toBeDefined();
    expect(pay!.params).not.toMatch(/\baddress\b/);
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
    expect(fnBody(src, "register")).toMatch(/activeAccount\s*=\s*firstAccount/);

    // The other is the ceremony.
    expect(fnBody(src, "activate")).toMatch(/activeAccount\s*=\s*s\.to/);
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

  it("names the business at registration, because the payer half needs one right answer", () => {
    // Without a designated party, any stranger could register as a payer and sign
    // the payer half themselves — and a single compromised vendor key would be
    // enough to redirect everything. The business is named up front precisely so
    // the check below has one right answer.
    expect(src).toMatch(/address\s+business;/);
    const register = fnBody(src, "register");
    expect(register).toMatch(/c\.business\s*=\s*business/);
    // And the business is not the account, because a counterparty that pays itself
    // can never rotate: the payer attestation needs a signer that is not the
    // account being replaced.
    expect(register).toMatch(/if\s*\(\s*business\s*==\s*firstAccount\s*\)\s*revert\s+BusinessIsRecipient/);
  });

  it("satisfies the payer half with the business key and no other", () => {
    const attest = fnBody(src, "attest");
    expect(attest).toMatch(/signer\s*!=\s*c\.business/);
    expect(attest).toMatch(/revert\s+NotBusiness/);
  });

  it("refuses a proposal that is stale or belongs to a broken record", () => {
    // A proposal is against the account that was active when it was made. Once that
    // changes, replaying the old proposal would move the counterparty twice, and the
    // middle address would never have signed for the second move.
    for (const fn of ["attest", "activate"]) {
      const body = fnBody(src, fn);
      expect(body, `${fn} must reject a stale proposal`).toMatch(
        /if\s*\(\s*s\.from\s*!=\s*c\.activeAccount\s*\)\s*revert\s+StaleProposal/,
      );
      expect(body, `${fn} must reject a broken record`).toMatch(/status\s*!=\s*CounterpartyStatus\.Clean/);
    }
  });

  it("binds the role into the signed digest, so a signature cannot be re-roled", () => {
    expect(src).toMatch(
      /SuccessionAttestation\(bytes32 counterpartyId,bytes32 successionId,address to,uint256 expiry,uint8 role\)/,
    );
    expect(fnBody(src, "attest")).toMatch(/successionDigest\([^)]*uint8\(role\)/);
  });

  it("lets one key count once per proposal, whatever role it is presented under", () => {
    // Role-binding alone is not enough: a fresh signature per role would let the
    // business satisfy its own demand for independent scrutiny.
    expect(src).toMatch(/mapping\(bytes32 => mapping\(address => bool\)\) public signerUsed/);
    expect(fnBody(src, "attest")).toMatch(/if\s*\(\s*signerUsed\[s\.id\]\[signer\]\s*\)\s*revert\s+SignerAlreadyUsed/);
  });

  it("requires the first account's consent to be registered at all", () => {
    // Without consent a stranger opens the record someone else's business is going
    // to need, and owns the payer half of it. "First to pay" only means something
    // once "first to type" is not enough.
    expect(src).toMatch(/REGISTRATION_CONSENT_TYPEHASH/);
    const register = fnBody(src, "register");
    expect(register).toMatch(/if\s*\(\s*consenter\s*!=\s*firstAccount\s*\)\s*revert\s+BadConsent/);
    // And names are labels, not identities: the same name may belong to two records.
    expect(register).not.toMatch(/NameTaken/);
    expect(register).toMatch(/if\s*\(_counterparties\[id\]\.status\s*!=\s*CounterpartyStatus\.None\s*\)\s*revert\s+IdTaken/);
  });

  it("lets only the business hand the payer side on", () => {
    expect(src).toMatch(/function\s+transferBusiness\(/);
    const t = src.slice(src.indexOf("function transferBusiness("));
    expect(t.slice(0, 800)).toMatch(/msg\.sender\s*!=\s*c\.business/);
  });

  it("keeps bricking and quorum-setting to business-or-account", () => {
    // Both used to admit any registered payer, and registration is permissionless —
    // so strangers could permanently brick a counterparty or set an unmeetable
    // quorum. The guards now name the two parties with standing.
    for (const fn of ["function discloseInheritance(", "function setQuorumRequired("]) {
      const body = src.slice(src.indexOf(fn));
      expect(body.slice(0, 1200)).toMatch(/msg\.sender\s*!=\s*c\.activeAccount\s*&&\s*msg\.sender\s*!=\s*c\.business/);
    }
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

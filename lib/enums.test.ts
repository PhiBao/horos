/**
 * The enums in lib/enums.ts have to agree with the enums in the Solidity contracts.
 *
 * This is the one place in the codebase where a constant is duplicated across two
 * languages, and it is duplicated because it has to be: the contract ABI encodes
 * enums as uint8 and carries no names, so there is no way to derive the labels from
 * the compiled artifact.
 *
 * The cost of the duplication is on display here. A missing leading `None` in
 * SuccessionState shifted every state by one, and the public record rendered an
 * activated ceremony as "Expired" - the page failing at the one thing it exists to
 * prove, with no error and no exception.
 *
 * So the order is asserted against the source of truth rather than trusted. The
 * Solidity is parsed rather than executed, which is enough: what matters is that
 * the declaration order matches, and the declaration order is exactly what these
 * enums encode.
 */

import {readFileSync} from "node:fs";
import {resolve} from "node:path";

import {describe, expect, it} from "vitest";

import {ATTEST_ROLE, COUNTERPARTY_STATUS, SUCCESSION_STATE} from "./enums.js";

/** Pull `enum Name { A, B, C }` out of a Solidity file, stripping comments. */
function readEnum(file: string, name: string): string[] {
  const source = readFileSync(resolve("contracts/src", file), "utf8")
    // Strip line comments first: the enum members are annotated with them, and a
    // comment containing a comma would be read as another member.
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  const body = source.match(new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`))?.[1];
  if (!body) throw new Error(`no enum ${name} found in ${file}`);

  return body
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

describe("enum order matches the contracts", () => {
  it("CounterpartyStatus", () => {
    expect(readEnum("CounterpartyRegistry.sol", "CounterpartyStatus")).toEqual([...COUNTERPARTY_STATUS]);
  });

  // The one that was wrong. Kept as its own test so a failure here says plainly
  // which page is about to start lying.
  it("SuccessionState, in order, starting with None", () => {
    const onchain = readEnum("CounterpartyRegistry.sol", "SuccessionState");
    expect(onchain).toEqual([...SUCCESSION_STATE]);
    expect(onchain[0]).toBe("None");
    // An activated ceremony must not be able to read as expired, in either system.
    expect(onchain.indexOf("Activated")).toBe(SUCCESSION_STATE.indexOf("Activated"));
    expect(onchain.indexOf("Expired")).toBe(SUCCESSION_STATE.indexOf("Expired"));
  });

  it("AttestRole", () => {
    expect(readEnum("CounterpartyRegistry.sol", "AttestRole")).toEqual([...ATTEST_ROLE]);
  });

  it("covers every member, so a new state cannot be silently unlabelled", () => {
    for (const [file, name, ours] of [
      ["CounterpartyRegistry.sol", "CounterpartyStatus", COUNTERPARTY_STATUS],
      ["CounterpartyRegistry.sol", "SuccessionState", SUCCESSION_STATE],
      ["CounterpartyRegistry.sol", "AttestRole", ATTEST_ROLE],
    ] as const) {
      expect(readEnum(file, name).length, `${name} has a different number of members`).toBe(ours.length);
    }
  });
});

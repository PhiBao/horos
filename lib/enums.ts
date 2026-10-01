/**
 * Enum labels, in the order the contracts declare them.
 *
 * These are the only values in the system that have to agree across two languages,
 * and a mismatch is silent in the worst possible way. The first version of the
 * Worker's mapping omitted the leading `None` from SuccessionState, so every state
 * was off by one - and an *activated* ceremony, the single thing the public record
 * exists to prove, rendered as "Expired".
 *
 * So the order is asserted against the Solidity source in enum.test.ts rather than
 * trusted. If someone reorders an enum in CounterpartyRegistry.sol, that test fails
 * rather than the deployed page quietly lying about who has been paid.
 */

/** CounterpartyRegistry.CounterpartyStatus */
export const COUNTERPARTY_STATUS = ["None", "Clean", "Broken"] as const;

/** CounterpartyRegistry.SuccessionState */
export const SUCCESSION_STATE = ["None", "Proposed", "Attested", "Activated", "Expired"] as const;

/** CounterpartyRegistry.AttestRole */
export const ATTEST_ROLE = ["OldKey", "Payer", "Quorum"] as const;

export type CounterpartyStatus = (typeof COUNTERPARTY_STATUS)[number];
export type SuccessionState = (typeof SUCCESSION_STATE)[number];

/**
 * Label a status code, or admit that it is not one.
 *
 * Returning a number in a string field is better than returning undefined: a page
 * that says "status 7" is obviously wrong, whereas one that says "Unknown" invites
 * the reader to assume it means something benign.
 */
export function labelStatus(code: number): string {
  return COUNTERPARTY_STATUS[code] ?? `unrecognised status ${code}`;
}

export function labelSuccessionState(code: number): string {
  return SUCCESSION_STATE[code] ?? `unrecognised state ${code}`;
}

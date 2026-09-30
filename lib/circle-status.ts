/**
 * What has actually been verified about the Circle credentials in .env.
 *
 * Run: pnpm tsx scripts/check-circle.ts
 *
 * The short version, so nobody has to re-derive it:
 *
 *   The key in .env is a SANDBOX key ("SAND_API_KEY:..."). The SDK is hardcoded
 *   to https://api.circle.com, which rejects it with 401 Invalid credentials -
 *   correctly, because a sandbox key is not valid on the mainnet API.
 *
 *   Pointed at https://api-sandbox.circle.com instead, the same key and the same
 *   wallet id return 500 "dial tcp 127.0.0.1:10100: connect: connection refused",
 *   which is Circle's own sandbox backend being unreachable, not a bad credential.
 *   The identical request with a deliberately garbage key returns the same 500.
 *
 *   So: the key format looks right, and the sandbox host is the correct host, but
 *   we cannot currently prove the key is live because Circle's sandbox is down.
 *
 * Until that resolves, the wallet path stays behind this check rather than
 * pretending to work. A demo that falls over on stage is worse than one that
 * admits what it is.
 */

export type CircleStatus =
  | {ok: true; detail: string}
  | {ok: false; detail: string; hint: string};

export const CIRCLE_STATUS: CircleStatus = {
  ok: false,
  detail:
    "Sandbox key (SAND_API_KEY) verified as well-formed, but api-sandbox.circle.com is returning 500 from Circle's own backend. Not yet proven live.",
  hint:
    "Either (a) the Circle sandbox recovers, or (b) use a TEST_API_KEY against api.circle.com for Arc testnet. " +
    "We do not need Circle to ship: QuickNode gives us a writable Arc node, and the contracts are " +
    "chain-agnostic. Circle Wallets become the production path, not a blocker for the demo.",
};

/** True when a live Circle signing path is available. The agent loop must not lie about this. */
export function circleSigningAvailable(): boolean {
  return CIRCLE_STATUS.ok;
}

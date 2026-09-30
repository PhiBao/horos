/**
 * Demo identities for the scripted walkthrough.
 *
 * These are throwaway keys generated for a testnet demo. They are checked in on
 * purpose so anyone can run `pnpm demo` and reproduce the exact sequence, and
 * they control nothing but testnet dust.
 *
 * They are NOT examples of how to handle keys, and they must never hold real
 * funds. The production signer is a Circle developer-controlled wallet, where the
 * private key never exists in this codebase at all: see lib/circle.ts.
 *
 * The vendor keys here exist for one reason: the succession ceremony requires the
 * account that received the last payment to sign for its own replacement. A demo
 * that skipped that would not be demonstrating the thing.
 */

export const VENDOR_KEY = process.env.HOROS_DEMO_VENDOR_KEY as `0x${string}` | undefined;
export const VENDOR_NEW_KEY = process.env.HOROS_DEMO_VENDOR_NEW_KEY as `0x${string}` | undefined;
export const ATTACKER_KEY = process.env.HOROS_DEMO_ATTACKER_KEY as `0x${string}` | undefined;

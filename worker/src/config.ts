/**
 * Constants the site needs that are not secrets and not chain reads.
 *
 * Kept in one file so there is a single place to look when asking "what does this
 * deployed site actually point at?" - which is the first question a judge asks and
 * the one hardest to answer from a bundle.
 */

export {POLICY_VERSION} from "../../lib/policy.js";

/**
 * Arc's explorer, for the "view on chain" links.
 *
 * Testnet by design. The contracts this site reads are a testnet deployment, and
 * pointing a public page at mainnet would imply a claim the repo does not make.
 */
export const EXPLORER = "https://explorer.testnet.arc.io";

/** USDC on Arc, same address on mainnet and testnet. Six decimals. */
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

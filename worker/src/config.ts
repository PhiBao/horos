/**
 * Constants the site needs that are not secrets and not chain reads.
 *
 * Kept in one file so there is a single place to look when asking "what does this
 * deployed site actually point at?" - which is the first question a judge asks and
 * the one hardest to answer from a bundle.
 */

export {POLICY_VERSION} from "../../lib/policy.js";

/**
 * One network, named in one place.
 *
 * The site used to have testnet baked into five files: an explorer constant in
 * three of them, RPC endpoints in the Worker config, and a chain label in the API
 * response. That is fine until the day you want it pointing somewhere else, at
 * which point "change the network" is a scavenger hunt with a deployed site as the
 * penalty for missing one.
 *
 * So the network is a variable, and everything downstream is derived. The frontend
 * no longer holds an explorer URL at all: the API tells it which chain it is
 * talking to, and the pages believe the API. A page that hardcodes an explorer can
 * disagree with the chain it is reading, and the disagreement looks like a broken
 * link rather than a wrong claim.
 */
export type NetworkKey = "arc-testnet" | "arc-mainnet";

export type NetworkProfile = {
  key: NetworkKey;
  /** The chain's own id, as the RPC reports it. */
  chainId: number;
  /** What to call it in the interface. */
  label: string;
  /** Where a reader can verify a transaction. */
  explorer: string;
  /** Public read endpoints, tried in order. */
  rpcUrls: string[];
  /**
   * A one-line description of who signs, shown beside the picker.
   *
   * The two deployments genuinely differ here and the difference is not cosmetic:
   * on testnet the agent holds no key at all, on mainnet it holds one. A picker that
   * silently swapped the custody model would be the most misleading control on the
   * site, so the model is printed next to it.
   */
  custody: string;
};

export const NETWORKS: Record<NetworkKey, NetworkProfile> = {
  "arc-testnet": {
    key: "arc-testnet",
    chainId: 5042002,
    label: "Arc Testnet",
    explorer: "https://explorer.testnet.arc.io",
    rpcUrls: [
      "https://rpc.testnet.arc.io",
      "https://rpc.blockdaemon.testnet.arc.io",
      "https://rpc.drpc.testnet.arc.io",
    ],
    custody: "keyless — Circle holds the only key",
  },
  "arc-mainnet": {
    key: "arc-mainnet",
    chainId: 5042,
    label: "Arc",
    explorer: "https://explorer.arc.io",
    rpcUrls: ["https://rpc.mainnet.arc.io", "https://rpc.blockdaemon.mainnet.arc.io"],
    custody: "real USDC — the agent signs with a local key",
  },
};

/**
 * Where a chain's contracts are, and which record to offer as the demo.
 *
 * Separate from the profile above because the profile is a fact about a chain and
 * this is a fact about a deployment of ours on it. They change for different
 * reasons: a chain gets a new RPC endpoint rarely, and we redeploy whenever the
 * contracts change.
 */
export type Deployment = {
  registry: `0x${string}`;
  vault: `0x${string}`;
  /**
   * The counterparty the "load a verified record" button fills in.
   *
   * Named per deployment rather than hardcoded in the page, because the id is
   * derived from the registry address and therefore differs on every deploy. A page
   * holding one id would be subtly wrong on half the deployments, which is exactly
   * the kind of wrong that looks like a broken demo.
   */
  demoCounterpartyId?: `0x${string}`;
};

export type DeploymentMap = Partial<Record<NetworkKey, Deployment>>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ID = /^0x[0-9a-fA-F]{64}$/;

/**
 * Parse the deployments out of the Worker's environment.
 *
 * JSON in a string, because Cloudflare's vars are strings and there is no nested
 * config. Parsed defensively: a typo here would otherwise surface as a site that
 * reads a zero address and reports no counterparties, which is indistinguishable
 * from a chain with nothing on it.
 */
export function resolveDeployments(raw: string | undefined): DeploymentMap {
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`HOROS_DEPLOYMENTS is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("HOROS_DEPLOYMENTS must be a JSON object keyed by network");
  }

  const out: DeploymentMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(key in NETWORKS)) {
      throw new Error(`HOROS_DEPLOYMENTS names "${key}", which is not a chain this site knows`);
    }
    const d = value as Record<string, unknown>;
    if (typeof d.registry !== "string" || !ADDRESS.test(d.registry)) {
      throw new Error(`HOROS_DEPLOYMENTS.${key}.registry is not an address: ${String(d.registry)}`);
    }
    if (typeof d.vault !== "string" || !ADDRESS.test(d.vault)) {
      throw new Error(`HOROS_DEPLOYMENTS.${key}.vault is not an address: ${String(d.vault)}`);
    }
    if (d.demoCounterpartyId !== undefined && (typeof d.demoCounterpartyId !== "string" || !ID.test(d.demoCounterpartyId))) {
      throw new Error(`HOROS_DEPLOYMENTS.${key}.demoCounterpartyId is not a counterparty id`);
    }
    out[key as NetworkKey] = {
      registry: d.registry as `0x${string}`,
      vault: d.vault as `0x${string}`,
      demoCounterpartyId: d.demoCounterpartyId as `0x${string}` | undefined,
    };
  }
  return out;
}

/**
 * Resolve the network from the Worker's environment.
 *
 * An unknown value is a hard failure rather than a silent fallback: a site that
 * quietly reads testnet while its configuration says mainnet is the worst of both,
 * because the numbers it shows look real.
 */
export function resolveNetwork(configured: string | undefined): NetworkProfile {
  const key = (configured ?? "arc-testnet").trim() as NetworkKey;
  const profile = NETWORKS[key];
  if (!profile) {
    throw new Error(
      `"${configured}" is not a chain this site knows. ` +
        `Set it to one of: ${Object.keys(NETWORKS).join(", ")}.`,
    );
  }
  return profile;
}

/**
 * The deployment for a chain, or a clear failure.
 *
 * Reading a zero address instead would produce a site that answers every question
 * with "no record", which reads as a chain with nothing on it rather than as a
 * missing configuration.
 */
export function deploymentFor(map: DeploymentMap, network: NetworkProfile): Deployment {
  const deployment = map[network.key];
  if (!deployment) {
    throw new Error(
      `This site has no deployment recorded for ${network.label}. ` +
        `Known: ${Object.keys(map).join(", ") || "none"}. Run pnpm sync:site after deploying.`,
    );
  }
  return deployment;
}

/** USDC on Arc, same address on mainnet and testnet. Six decimals. */
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

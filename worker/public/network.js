/**
 * The network picker, in one place.
 *
 * Three pages need to know which chain they are talking to, and the answer has to be
 * the same on all of them. So the network travels as a query parameter, is
 * remembered in local storage, and is announced by `/api/networks` rather than
 * written into any page. A page that hardcoded a chain would be wrong on the next
 * deployment, and wrong in the way that looks like a broken link rather than a false
 * claim.
 *
 * The custody difference between the chains is printed next to the picker on
 * purpose. On testnet the agent holds no key at all; on mainnet it holds one. A
 * control that silently swapped the custody model under the reader would be the most
 * misleading thing on the site.
 */

const STORAGE_KEY = "horos.network";

let networks = [];
let current = null;

/**
 * Which chains this deployment can read, and where their records are.
 *
 * `prefer` is for a page whose own copy is about one chain: `/start` is the testnet
 * pilot and opens on testnet, because a page that says "the money is test money" under
 * a header saying "real USDC" contradicts itself in the first two lines. An explicit
 * `?network=` still wins, and the reader's remembered choice still applies everywhere
 * else - the pilot page is the only one that asserts a chain rather than asking.
 */
export async function initNetwork({prefer} = {}) {
  try {
    const res = await fetch("/api/networks");
    if (!res.ok) throw new Error(`networks list failed (${res.status})`);
    const data = await res.json();
    networks = Array.isArray(data.networks) ? data.networks : [];
    const fromUrl = new URLSearchParams(location.search).get("network");
    const wanted =
      fromUrl ??
      (prefer && networks.some((n) => n.key === prefer) ? prefer : null) ??
      localStorage.getItem(STORAGE_KEY) ??
      data.default;
    current = networks.find((n) => n.key === wanted) ?? networks.find((n) => n.key === data.default) ?? networks[0] ?? null;
  } catch {
    // A picker that cannot load is not a reason to blank the page: the API will
    // still answer with whatever the Worker defaults to.
    networks = [];
    current = null;
  }
  return {networks, current};
}

export const networkKey = () => current?.key ?? null;
export const networkLabel = () => current?.label ?? "Arc";
export const demoCounterpartyId = () => current?.demoCounterpartyId ?? null;
/** Every chain this site can read, as `/api/networks` described them. */
export const networkList = () => networks;
/**
 * Where to verify a transaction on the chain currently selected.
 *
 * Exported so no page has to carry a fallback of its own: a hardcoded explorer is a
 * claim about which chain you are reading, and the one place that claim is written is
 * here, from the API. Before this existed the pages fell back to the testnet explorer,
 * so a mainnet page that failed to load its card would quietly offer to show the
 * reader the wrong chain.
 */
export const networkExplorer = () => current?.explorer ?? null;

/** Append the current network to a path, so links are shareable and unambiguous. */
export function withNetwork(path) {
  return current ? withNetworkOf(current.key, path) : path;
}

/**
 * The same, for a chain that is not the one selected.
 *
 * Used where the answer is "not here, but there": a record link that arrives while
 * the reader's remembered chain is the other one should be able to point at the chain
 * that actually holds it, without silently changing what they are reading.
 */
export function withNetworkOf(key, path) {
  const url = new URL(path, location.origin);
  url.searchParams.set("network", key);
  return url.pathname + url.search;
}

function announce(key) {
  const url = new URL(location.href);
  url.searchParams.set("network", key);
  history.replaceState(null, "", url);
  localStorage.setItem(STORAGE_KEY, key);
}

/**
 * Fill a <select> and wire it up.
 *
 * `onChange` runs after the choice is committed, because a page that re-renders
 * before it knows which chain it is reading will render the old chain's answer.
 */
export function mountPicker(select, onChange) {
  if (!select) return;
  if (networks.length === 0) {
    select.remove();
    return;
  }

  select.innerHTML = networks
    .map((n) => `<option value="${n.key}"${n.key === current?.key ? " selected" : ""}>${n.label}</option>`)
    .join("");
  select.hidden = false;

  const custody = document.querySelector("[data-custody]");
  const showCustody = () => {
    if (!custody) return;
    custody.textContent = current ? `${current.chainId} · ${current.custody}` : "";
  };
  showCustody();

  select.addEventListener("change", async () => {
    current = networks.find((n) => n.key === select.value) ?? current;
    announce(current.key);
    showCustody();
    await onChange?.(current);
  });
}

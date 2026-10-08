/**
 * The public record for one counterparty. No signup, no key, no account.
 *
 * This page is the compounding asset. A counterparty's lineage is the only thing
 * here that gets more valuable over time and the only thing an attacker cannot
 * fabricate: you cannot buy fourteen payments of history, you can only accumulate
 * them. It is also the page that makes the failure mode survivable - if a key is
 * lost, the break is recorded here, permanently, where everyone who might pay this
 * counterparty can see it.
 *
 * Read-only, like everything else on this site.
 */
import {
  initNetwork,
  mountPicker,
  networkExplorer,
  networkKey,
  networkLabel,
  networkList,
  withNetwork,
  withNetworkOf,
  demoCounterpartyId,
} from "./network.js";

const $ = (sel) => document.querySelector(sel);

/** Set from the API response: the page describes a chain it does not choose. */
/* Set from the record response, and from the picker before that - never a constant
   naming one chain, because this page tells a reader where to verify a transaction. */
let EXPLORER = "";

/** Shorten an address for display without losing the ends, which is where diffs show. */
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function idFromPath() {
  const m = location.pathname.match(/^\/c\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function render(data) {
  const cp = data.counterparty;
  EXPLORER = data.chain?.explorer ?? EXPLORER;
  const el = $("#record");
  el.hidden = false;

  if (!cp.exists) {
    const demo = demoCounterpartyId();
    // An id is derived from the registry address, so the same counterparty has one id
    // per chain and a link to a record can arrive while the other chain is selected.
    // Since the picker remembers the reader's choice, that is a dead end waiting for
    // anyone who tries testnet and then follows a link from the README. So before
    // saying "no record", ask the other chains whether they know this id - a fact read
    // from them, not a guess about which chain the reader meant.
    const elsewhere = (await findOnOtherChains(cp.id)).filter((n) => n.key !== networkKey());
    el.innerHTML = `
      <h1 class="verdict hold">No record${
        elsewhere.length ? ` on ${esc(networkLabel())}` : ""
      }</h1>
      <p class="headline">Nobody has ever paid this counterparty, so there is nothing to show and nothing on file to verify against.</p>
      ${
        elsewhere.length
          ? elsewhere
              .map(
                (n) =>
                  `<p class="found-elsewhere">This counterparty does have a record on
                   <strong>${esc(n.label)}</strong> &mdash;
                   <a href="${esc(withNetworkOf(n.key, `/c/${cp.id}`))}">open it there</a>.</p>`,
              )
              .join("")
          : ""
      }
      <p class="prose-p">That is the honest answer rather than an error. A counterparty id is derived
      from a name and the first account paid, so an id with no record means either that no payment has
      been made yet, or that somebody typed the id wrong. In both cases the useful thing to say is
      that there is no history — not that the record is empty.</p>
      <p class="mono">${esc(cp.id)}</p>
      ${
        demo
          ? `<p><a href="${esc(withNetwork(`/c/${demo}`))}">This chain's verified record &rarr;</a>
             <span class="none">— a counterparty this deployment has actually paid</span></p>`
          : ""
      }
      <p><a href="${esc(withNetwork("/"))}">Back to the decision card</a></p>`;
    return;
  }

  const sigs = (n, need = 2) => `${n} of ${need} signatures`;

  /**
   * Successions that have not finished.
   *
   * Activated ones are history and belong in the lineage; expired ones are dead and
   * belong nowhere. Both are still fetched, so the page can say plainly that nothing
   * is pending rather than leaving the reader to infer it from an absence.
   */
  const pending = cp.successions.filter((s) => s.state === "Proposed" || s.state === "Attested");

  el.innerHTML = `
    <div class="verdict-row">
      <h1 class="verdict ${cp.status === "Broken" ? "hold" : "release"}">${cp.status === "Broken" ? "Broken" : "Payable"}</h1>
      <div>
        <p class="cp-name">${esc(cp.displayName || cp.canonicalName || "(unnamed)")}</p>
        <p class="mono">${esc(cp.id)}</p>
      </div>
    </div>

    <dl class="facts" data-block="facts">
      <div>
        <dt>Pays to, right now</dt>
        <dd class="mono strong">${esc(cp.activeAccount)}</dd>
      </div>
      <div>
        <dt>Accounts it has ever been paid at</dt>
        <dd>${cp.accountCount}</dd>
      </div>
      <div>
        <dt>Unapproved changes on record</dt>
        <dd>0</dd>
      </div>
      <div>
        <dt>Vault budget for this counterparty</dt>
        <dd>${esc(data.budgets.counterpartyCap)} USDC</dd>
      </div>
    </dl>

    <h2 data-block="succession">The succession</h2>
    <p class="prose-p">In order. An account only appears here after it has been paid, or after two
    parties who are not the recipient signed for it. Nothing in this list was edited — each entry is a
    transaction, and each one links to the explorer.</p>
    <ol class="lineage" data-block="lineage">
      ${cp.lineage
        .map(
          (e) => `
        <li>
          <div class="ln-head">
            <span class="mono strong">${esc(short(e.account))}</span>
            ${e.successorOf ? `<span class="tag">${sigs(e.signatures)}</span>` : `<span class="tag plain">opened by payment evidence</span>`}
          </div>
          <div class="ln-body">
            <p>${e.successorOf ? `Replaced <span class="mono">${esc(short(e.successorOf))}</span>` : "First account on record."}
            ${e.activatedBy ? ` · authorised by <span class="mono">${esc(short(e.activatedBy))}</span>` : ""}</p>
            <p class="when">${esc(new Date(e.activatedAt).toISOString().slice(0, 10))} ·
              <a href="${EXPLORER}/address/${esc(e.account)}" target="_blank" rel="noopener">on Arc</a></p>
          </div>
        </li>`,
        )
        .join("") || `<li class="empty">No accounts yet.</li>`}
    </ol>

    ${
      // Only the ones that have not finished. An activated succession is already in
      // the lineage above, and listing it here under a heading that says "cannot
      // receive anything" contradicts the badge next to it — which is exactly what
      // the first capture of this page showed.
      pending.length
        ? `<h2>Proposed, and not yet able to receive anything</h2>
           <p class="prose-p">A proposal becomes payable only if both required signatures
           arrive before the window closes. The account that would receive the money can
           never supply either one.</p>
           <ul class="pending">
             ${pending
               .map(
                 (s) => `<li>
                   <span class="mono">${esc(short(s.to))}</span>
                   <span class="tag">${esc(s.state)}</span>
                   <span class="sig ${s.oldKeyAttested ? "yes" : "no"}">${s.oldKeyAttested ? "✓" : "—"} last-paid account</span>
                   <span class="sig ${s.payerAttested ? "yes" : "no"}">${s.payerAttested ? "✓" : "—"} business</span>
                 </li>`,
               )
               .join("")}
           </ul>`
        : `<h2>Nothing pending</h2>
           <p class="prose-p">No proposal is in flight. If one were, it would appear here
           with the two signatures it still needs, and it could not receive anything
           until both arrived.</p>`
    }

    <h2>Check it yourself</h2>
    <p class="prose-p">This page is a rendering, and you should not have to trust a rendering. The
    registry can be read directly, by anyone, without this site:</p>
    <pre class="mono call">${esc(data.chain.registry)}
activeAccount(${esc(cp.id)}) → ${esc(cp.activeAccount)}</pre>
    <p class="mono small">
      <a href="${EXPLORER}/address/${esc(data.chain.registry)}" target="_blank" rel="noopener">registry</a> ·
      <a href="${EXPLORER}/address/${esc(data.chain.vault)}" target="_blank" rel="noopener">vault</a> ·
      chain ${data.chain.chainId}
    </p>`;
}

/**
 * Which other chains know this id.
 *
 * Asked of each chain's own registry through the same API, and a failure is reported
 * as "not there" rather than thrown: this runs on the path that is already telling a
 * reader there is nothing to show, and turning that into an error would replace a
 * clear answer with a stack trace.
 */
async function findOnOtherChains(id) {
  const others = networkList().filter((n) => n.key !== networkKey());
  const found = await Promise.all(
    others.map(async (n) => {
      try {
        const res = await fetch(
          `/api/counterparty/${encodeURIComponent(id)}?network=${encodeURIComponent(n.key)}`,
        );
        if (!res.ok) return null;
        const data = await res.json();
        // `exists` lives under `counterparty` in this response - worth naming, since
        // reading it off the top level is a silent `undefined` and the offer just
        // never appears.
        return data.counterparty?.exists ? n : null;
      } catch {
        return null;
      }
    }),
  );
  return found.filter(Boolean);
}

async function main() {
  await initNetwork();
  EXPLORER = networkExplorer() ?? "";
  mountPicker($("#network"), async () => {
    // Same id, other chain. It may not exist there, and "no record" is the honest
    // answer — the page offers that chain's own verified record underneath.
    EXPLORER = networkExplorer() ?? "";
    await load();
  });

  await load();
}

async function load() {
  const id = idFromPath();
  const el = $("#record");

  if (!id) {
    // /c/ with no id: say what this page is for rather than 404ing.
    el.hidden = false;
    el.innerHTML = `
      <h1>Counterparty records</h1>
      <p class="prose-p">Every counterparty Horos has paid has a page at <span class="mono">/c/&lt;id&gt;</span>.
      Paste an id, or reach one from the decision card. There is no index, and that is deliberate —
      listing every counterparty this deployment has would leak the customer list to anyone who asks.</p>
      <form class="lookup" onsubmit="return false">
        <input id="lookup-id" class="mono" spellcheck="false" placeholder="0x… 64 hex characters">
        <button type="button" id="lookup-go">Open</button>
      </form>
      <p><a href="/">Back to the decision card</a></p>`;
    $("#lookup-go").addEventListener("click", () => {
      const v = $("#lookup-id").value.trim();
      if (/^0x[0-9a-fA-F]{64}$/.test(v)) location.href = withNetwork(`/c/${v.toLowerCase()}`);
      else el.querySelector(".lookup").insertAdjacentHTML("beforebegin", `<p class="err">That is not a counterparty id: it must be 0x followed by 64 hex characters.</p>`);
    });
    return;
  }

  el.hidden = false;
  el.innerHTML = `<p class="hint">Reading the registry…</p>`;

  try {
    const res = await fetch(withNetwork(`/api/counterparty/${encodeURIComponent(id)}`));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `the registry read failed (${res.status})`);
    await render(data);
  } catch (err) {
    el.innerHTML = `
      <h1 class="verdict hold">Could not read the registry</h1>
      <p class="headline">${esc(err.message)}</p>
      <p class="prose-p">The contract is unaffected by this page being unable to reach it. If money is
      mid-flight it is still governed by the same rules; this is a display failure, not a change in the
      rules.</p>`;
  }
}

main();

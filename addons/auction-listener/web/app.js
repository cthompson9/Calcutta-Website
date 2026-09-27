const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (className) el.className = className;
  return el;
};
const money = (cents) =>
  Number.isInteger(cents)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(cents / 100)
    : "—";
let live = { drafts: [], transcript: [] },
  capture = { recording: false },
  website = {},
  editing = null,
  nomination = null,
  lastRows = "",
  lastTranscript = "";
async function api(path, body) {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error || "Could not reach the listener.");
  return value;
}
function error(text) {
  $("error").textContent = text || "";
  $("error").hidden = !text;
}
function controls() {
  $("start").disabled =
    !window.capture ||
    !live.ready ||
    capture.recording ||
    capture.status === "starting";
  $("stop").disabled = !capture.recording;
  $("indicator").classList.toggle("active", !!capture.recording);
  $("status").textContent = capture.recording
    ? "Listening"
    : {
        starting: "Starting…",
        stopped: "Stopped",
        permission: "Audio permission needed",
        error: "Recorder needs attention",
        warning: "Check connection",
      }[capture.status] || "Ready";
  $("status-detail").textContent =
    capture.message || "Connect to an auction to begin.";
  $("permission").hidden = capture.status !== "permission";
  $("connection").textContent = live.ready ? "Connected" : "Not connected";
  $("auction").textContent =
    (website.auction ? `${website.auction.name} — Auction #${website.auction.id}` : null) ||
    "Open the listener from your website’s Auction tab.";
  const lot =
    capture.recording && live.ready
      ? live.context?.lots.find(
          (l) => l.id === live.context.currentLotId && l.status === "bidding",
        )
      : null;
  $("current").textContent = lot?.displayName || "";
  if (nomination !== lot?.nominationId) {
    nomination = lot?.nominationId;
    $("current").classList.remove("new-lot");
    if (lot) {
      void $("current").offsetWidth;
      $("current").classList.add("new-lot");
    }
  }
  $("pending").textContent = live.pending
    ? `${live.pending} awaiting website confirmation`
    : "";
}
function render() {
  controls();
  const transcriptKey = JSON.stringify(live.transcript);
  if (transcriptKey !== lastTranscript) {
    lastTranscript = transcriptKey;
    $("transcript").replaceChildren(
      ...(live.transcript.length
        ? live.transcript.map((t) =>
            node("article", t.text, t.final ? "" : "partial"),
          )
        : [node("p", "Waiting for speech.", "muted")]),
    );
  }
  if (editing) return;
  const key = JSON.stringify([
    live.context,
    live.drafts,
    capture.recording,
    live.ready,
  ]);
  if (key === lastRows) return;
  lastRows = key;
  const context = live.context,
    rows = [];
  const active =
    capture.recording && live.ready
      ? context?.lots.find(
          (l) => l.id === context.currentLotId && l.status === "bidding",
        )
      : null;
  const saleIds = new Set(context?.sales.map((s) => s.id));
  const drafts = live.drafts.filter(
    (d) =>
      d.status !== "dismissed" &&
      !(d.status === "submitted" && saleIds.has(d.saleId)),
  );
  if (active && !drafts.some((d) => d.lotId === active.id))
    rows.push(
      resultRow(
        { lotId: active.id, allocations: [], status: "waiting" },
        active,
      ),
    );
  for (const draft of [...drafts].reverse())
    rows.push(resultRow(draft, active));
  for (const sale of [...(context?.sales ?? [])].reverse()) {
    const shares = new Map();
    for (const a of sale.allocations) {
      const key = a.consortiumId ?? `bidder-${a.bidderId}`;
      const existing = shares.get(key) ?? {
        consortiumId: a.consortiumId,
        heardName: a.consortiumName || a.bidderName,
        basisPoints: 0,
      };
      existing.basisPoints += Math.round(Number(a.share) * 10000);
      shares.set(key, existing);
    }
    rows.push(
      resultRow({
        ...sale,
        allocations: [...shares.values()],
        status: "submitted",
      }),
    );
  }
  rows.sort(
    (a, b) =>
      Number(b.classList.contains("active-lot")) -
      Number(a.classList.contains("active-lot")),
  );
  $("results").replaceChildren(...rows);
  $("empty").hidden = !!rows.length;
}
function flagged(cell, message) {
  if (!message) return;
  cell.classList.add("needs-review");
  cell.append(node("small", `Needs a look: ${message}`));
}
function resultRow(draft, active) {
  const tr = node("tr", null, draft.lotId === active?.id ? "active-lot" : "");
  const lot = node(
    "td",
    live.context?.lots.find((l) => l.id === draft.lotId)?.displayName ||
      "Select lot",
  );
  flagged(lot, draft.issues?.lot);
  const buyers = node("td"),
    shares = node("td");
  for (const a of draft.allocations) {
    buyers.append(
      node(
        "div",
        live.context?.consortia.find((c) => c.id === a.consortiumId)
          ?.displayName ||
          a.heardName ||
          "Unknown winner",
      ),
    );
    shares.append(
      node("div", a.basisPoints == null ? "—" : `${a.basisPoints / 100}%`),
    );
  }
  flagged(buyers, draft.issues?.owners);
  flagged(shares, draft.issues?.shares);
  const amount = node("td", money(draft.totalCents));
  flagged(amount, draft.issues?.amount);
  const action = node("td");
  action.append(
    node(
      "span",
      {
        submitted: "Saved on website",
        pending: "Pending delivery",
        review: "Needs a look",
        waiting: "Waiting for sale",
      }[draft.status],
    ),
  );
  flagged(action, draft.issues?.announcement || draft.issues?.submission);
  if (draft.message && draft.status !== "submitted")
    action.append(node("small", draft.message));
  if (["review", "waiting"].includes(draft.status)) {
    const edit = node(
      "button",
      draft.status === "waiting" ? "Enter result" : "Correct & submit",
      "secondary",
    );
    edit.onclick = () => editRow(tr, draft);
    action.append(edit);
    if (draft.status === "review") {
      const dismiss = node("button", "Dismiss", "secondary");
      dismiss.onclick = async () => {
        try {
          live = await api("/api/live/dismiss", { id: draft.id });
          lastRows = "";
          render();
        } catch (e) {
          error(e.message);
        }
      };
      action.append(dismiss);
    }
  }
  tr.append(lot, buyers, shares, amount, action);
  return tr;
}
async function editRow(tr, draft) {
  if (editing) return;
  editing = {};
  try {
    draft = await api("/api/live/review", {
      id: draft.id,
      expectedRevision: draft.revision,
      lotId: draft.lotId,
    });
  } catch (e) {
    editing = null;
    error(e.message);
    return;
  }
  editing = { ...draft };
  const lot = node("select");
  lot.setAttribute("aria-label", "Confirm lot");
  for (const l of live.context.lots.filter((l) => l.status === "bidding")) {
    const o = node("option", l.displayName);
    o.value = l.id;
    lot.append(o);
  }
  lot.value = String(draft.lotId ?? "");
  const lotCell = node("td");
  lotCell.append(lot, node("small", "Confirm this is the lot you heard."));
  const buyers = node("td"),
    shares = node("td"),
    inputs = [];
  function allocation(value = {}) {
    const select = node("select");
    select.setAttribute("aria-label", "Winning consortium");
    const blank = node("option", "Choose consortium");
    blank.value = "";
    select.append(blank);
    for (const c of live.context.consortia.filter((c) => c.active === 1)) {
      const o = node("option", c.displayName);
      o.value = c.id;
      select.append(o);
    }
    select.value = String(value.consortiumId ?? "");
    const percent = node("input");
    percent.type = "number";
    percent.min = "0.01";
    percent.max = "100";
    percent.step = "0.01";
    percent.value =
      value.basisPoints == null ? "" : String(value.basisPoints / 100);
    percent.setAttribute("aria-label", "Ownership percentage");
    const holder = node("div"),
      remove = node("button", "Remove", "secondary");
    holder.append(select, remove);
    buyers.append(holder);
    shares.append(percent);
    const pair = { select, percent };
    inputs.push(pair);
    remove.onclick = () => {
      inputs.splice(inputs.indexOf(pair), 1);
      holder.remove();
      percent.remove();
    };
  }
  for (const value of draft.allocations.length
    ? draft.allocations
    : [{ basisPoints: 10000 }])
    allocation(value);
  const add = node("button", "Add winner", "secondary");
  add.onclick = () => {
    if (inputs.length < 8) allocation();
  };
  buyers.append(add);
  const price = node("input");
  price.type = "number";
  price.min = "0.01";
  price.max = "1000000";
  price.step = "0.01";
  price.value = draft.totalCents == null ? "" : String(draft.totalCents / 100);
  price.setAttribute("aria-label", "Final amount in dollars");
  const amount = node("td");
  amount.append(price);
  const action = node("td"),
    submit = node("button", "Submit"),
    cancel = node("button", "Cancel", "secondary"),
    message = node("small");
  message.setAttribute("role", "alert");
  action.append(submit, cancel, message);
  cancel.onclick = () => {
    editing = null;
    lastRows = "";
    render();
  };
  submit.onclick = async () => {
    try {
      if (
        !lot.value ||
        !price.value ||
        !price.checkValidity() ||
        inputs.some(
          (p) =>
            !p.select.value || !p.percent.value || !p.percent.checkValidity(),
        )
      )
        throw new Error(
          "Choose a lot and winners, then enter valid percentages and amount.",
        );
      submit.disabled = true;
      live = await api("/api/live/result", {
        id: draft.id,
        expectedRevision: draft.revision,
        lotId: Number(lot.value),
        totalCents: Math.round(Number(price.value) * 100),
        allocations: inputs.map((p) => ({
          consortiumId: Number(p.select.value),
          basisPoints: Math.round(Number(p.percent.value) * 100),
        })),
      });
      editing = null;
      lastRows = "";
      render();
    } catch (e) {
      message.textContent = e.message;
      submit.disabled = false;
    }
  };
  tr.replaceChildren(lotCell, buyers, shares, amount, action);
}
async function poll() {
  try {
    const previousAuction = live.auctionKey;
    [live, website] = await Promise.all([
      api("/api/live"),
      api("/api/website"),
    ]);
    if(previousAuction !== live.auctionKey) {
      editing = null;
      lastRows = "";
      lastTranscript = "";
      nomination = null;
    }
    error(live.error);
    render();
  } catch (e) {
    live.ready = false;
    controls();
    error(e.message);
  } finally {
    setTimeout(poll, 1000);
  }
}
async function init() {
  const token = location.hash.slice(1);
  if (token) {
    history.replaceState(null, "", "/");
    await api("/api/auth", { token });
  }
  if (window.capture) {
    capture = await window.capture.status();
    window.capture.onStatus((s) => {
      capture = s;
      render();
    });
    window.capture.onWebsite((s) => {
      website = s;
      controls();
    });
    $("start").onclick = async () => {
      try {
        capture = await window.capture.start();
        render();
      } catch (e) {
        error(e.message);
      }
    };
    $("stop").onclick = async () => {
      try {
        capture = await window.capture.stop();
        render();
      } catch (e) {
        error(e.message);
      }
    };
    $("permission").onclick = () =>
      window.capture.permissions(capture.permission);
  }
  await poll();
}
init().catch((e) => error(e.message));

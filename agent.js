/* ============ PREMVIO — Agent panel ============ */
const A = { me: null, tab: "load", channel: null };
const root = $("#root");

sb.auth.getSession().then(async ({ data }) => {
  if (data.session) {
    try {
      const p = await getMyProfile();
      if (p && ["agent", "admin"].includes(p.role) && !p.blocked) return start(p);
      await sb.auth.signOut();
    } catch (e) {}
  }
  staffLogin(root, "Agent", ["agent", "admin"], start);
});

const AGENT_TABS = [
  { id: "load", label: "Deposit", icon: ICONS.cash },
  { id: "withdraw", label: "Withdrawal", icon: ICONS.wallet },
  { id: "history", label: "My history", icon: ICONS.clock },
  { id: "profile", label: "My profile", icon: ICONS.users },
];

function start(p) {
  A.me = p;
  applyTheme("dark");
  root.innerHTML = `
  <div class="app">
    <header class="topbar">
      <img src="img/logo.png" alt="">
      <div class="grow"><div class="title">Agent panel</div><div class="small muted">${esc(p.full_name)} · <b class="mono">${esc(p.member_id)}</b>${p.city ? " · " + esc(p.city) : ""}</div></div>
      <button class="icon-btn" id="push" title="Notifications">${ICONS.bell}</button>
      <button class="icon-btn" id="out" title="Log out">${ICONS.logout}</button>
    </header>
    ${p.role === "agent" ? `<div class="balance-card mb"><div class="label">Your agent balance</div>
      <div class="amount" data-balance>${money(p.balance)}</div>
      <div class="member">Depositing to a customer uses this balance. Paying a withdrawal adds to it.</div></div>` : ""}
    <div class="money-actions mb">
      <button class="btn deposit" data-go="load">${ICONS.cash} Deposit</button>
      <button class="btn withdraw" data-go="withdraw">${ICONS.wallet} Withdrawal</button></div>
    <div class="tabs mb">${AGENT_TABS.map((t) => `<button data-t="${t.id}">${t.label}</button>`).join("")}</div>
    <main id="view"></main>
  </div>`;
  $$(".tabs button").forEach((b) => (b.onclick = () => { A.tab = b.dataset.t; render(); }));
  $$("[data-go]").forEach((b) => (b.onclick = () => { A.tab = b.dataset.go; render(); }));
  $("#out").onclick = async () => { await disablePush().catch(() => {}); await sb.auth.signOut(); location.reload(); };
  $("#push").onclick = async () => { if (await enablePush()) toast("Notifications on for this device.", "success"); };
  A.channel = sb.channel("agent-" + p.id)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${p.id}` }, (x) => {
      A.me = { ...A.me, ...x.new };
      $$("[data-balance]").forEach((el) => (el.textContent = money(A.me.balance)));
    }).subscribe();
  if (pushSupported() && Notification.permission === "granted") enablePush(true);
  render();
}

function render() {
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === A.tab));
  const v = $("#view");
  ({ load: viewLoad, withdraw: viewWithdraw, history: viewHistory, profile: viewProfile })[A.tab](v);
}

/* -------- Load money into a customer's account -------- */
function viewLoad(v) {
  v.innerHTML = `<div class="card">
    <h2 style="color:var(--green)">Deposit to a customer</h2>
    <p class="muted small">Ask the customer for their Member ID (e.g. PV100001), email or phone.</p>
    <form id="find" class="row"><input name="q" placeholder="Member ID, email or phone" required class="grow">
      <button class="btn">Find</button></form>
    <div id="cust"></div>
  </div>`;
  $("#find").onsubmit = (e) => {
    e.preventDefault();
    busy($("button", e.target), async () => {
      const { data, error } = await sb.rpc("agent_find_customer", { p_query: e.target.q.value });
      if (error) throw error;
      showCustomer(data);
    });
  };
}
function showCustomer(c) {
  const box = $("#cust");
  box.innerHTML = `<div class="card mt" style="box-shadow:none;background:var(--card-2)">
    <div class="setting-row"><span class="muted">Name</span><b>${esc(c.full_name)}</b></div>
    <div class="setting-row"><span class="muted">Member ID</span><b class="mono">${esc(c.member_id)}</b></div>
    <div class="setting-row"><span class="muted">Phone</span><b>${esc(c.phone || "—")}</b></div>
    <div class="setting-row"><span class="muted">Country</span><b>${esc(c.country || "—")}</b></div>
    <div class="setting-row"><span class="muted">KYC</span><span class="badge ${c.kyc_status}">${esc(c.kyc_status)}</span></div>
    ${c.blocked ? `<p class="mt" style="color:var(--red)"><b>This customer is blocked.</b></p>` : `
    <form id="lf" class="mt"><label>Amount to deposit (${CFG.CURRENCY})</label>
      <input type="number" name="amount" min="1" step="0.01" required inputmode="decimal">
      <button class="btn block deposit mt">Deposit</button></form>`}
  </div>`;
  const lf = $("#lf");
  if (!lf) return;
  lf.onsubmit = async (e) => {
    e.preventDefault();
    const amt = Number(lf.amount.value);
    if (!(amt > 0)) return toast("Enter a valid amount.", "error");
    if (A.me.role === "agent" && amt > Number(A.me.balance)) return toast("Not enough agent balance. Ask admin to deposit to your account.", "error");
    if (!(await confirmBox("Confirm deposit", `Deposit <b>${money(amt)}</b> to <b>${esc(c.full_name)}</b> (${esc(c.member_id)})?<br>Only confirm after you've received the cash.`, "Deposit now"))) return;
    busy($("button", lf), async () => {
      const { error } = await sb.rpc("agent_load_customer", { p_member_id: c.member_id, p_amount: amt });
      if (error) throw error;
      toast(`${money(amt)} deposited to ${c.full_name}.`, "success");
      $("#cust").innerHTML = `<div class="empty"><div class="big">✅</div><b>${money(amt)}</b> deposited to ${esc(c.full_name)}</div>`;
    });
  };
}

/* -------- Pay out a withdrawal code -------- */
function viewWithdraw(v) {
  v.innerHTML = `<div class="card">
    <h2 style="color:var(--red)">Withdrawal payout</h2>
    <p class="muted small">Enter the customer's 8-character withdrawal code.</p>
    <form id="cf" class="row"><input name="code" placeholder="e.g. K7M2QX9A" required class="grow mono" maxlength="8" style="text-transform:uppercase">
      <button class="btn">Check</button></form>
    <div id="wbox"></div>
  </div>`;
  $("#cf").onsubmit = (e) => {
    e.preventDefault();
    busy($("button", e.target), async () => {
      const { data, error } = await sb.rpc("agent_lookup_withdrawal", { p_code: e.target.code.value });
      if (error) throw error;
      showWithdrawal(data);
    });
  };
}
function showWithdrawal(w) {
  const ok = w.status === "pending";
  $("#wbox").innerHTML = `<div class="card mt" style="box-shadow:none;background:var(--card-2)">
    <div class="code-box mb"><div class="code mono">${esc(w.code)}</div><span class="badge ${w.status}">${esc(w.status)}</span>
      ${ok ? `<div class="small mt" style="color:var(--orange);font-weight:700">${timeLeft(w.expires_at)}</div>` : ""}</div>
    <div class="setting-row"><span class="muted">Customer</span><b>${esc(w.full_name)}</b></div>
    <div class="setting-row"><span class="muted">Member ID</span><b class="mono">${esc(w.member_id)}</b></div>
    <div class="setting-row"><span class="muted">Phone</span><b>${esc(w.phone || "—")}</b></div>
    <div class="setting-row"><span class="muted">Amount</span><b style="color:var(--gold);font-size:1.3rem">${money(w.amount)}</b></div>
    <div class="setting-row"><span class="muted">Location</span><b>${esc(w.city)}, ${esc(w.street)}</b></div>
    <div class="setting-row"><span class="muted">Requested</span><b>${fmtDate(w.created_at)}</b></div>
    ${ok ? `<button class="btn block withdraw mt" id="payBtn">Confirm — I paid ${money(w.amount)}</button>` : `<p class="mt muted">This code can't be paid out.</p>`}
  </div>`;
  const b = $("#payBtn");
  if (b) b.onclick = async () => {
    if (!(await confirmBox("Confirm payout", `Have you handed <b>${money(w.amount)}</b> to <b>${esc(w.full_name)}</b>? This can't be undone.`, "Yes, paid"))) return;
    busy(b, async () => {
      const { error } = await sb.rpc("agent_complete_withdrawal", { p_code: w.code });
      if (error) throw error;
      toast("Withdrawal completed.", "success");
      $("#wbox").innerHTML = `<div class="empty"><div class="big">✅</div>Paid <b>${money(w.amount)}</b> to ${esc(w.full_name)}</div>`;
    });
  };
}

/* -------- Agent's own history -------- */
async function viewHistory(v) {
  v.innerHTML = `<div class="card"><h2>My activity</h2><p class="muted small">Last 30 days</p><div id="ah"><div class="loader"></div></div></div>`;
  const { data, error } = await sb.rpc("agent_recent");
  if (error) { $("#ah").innerHTML = `<div class="empty">${esc(errMsg(error))}</div>`; return; }
  const label = { agent_load: "Deposit to customer", agent_payout: "Withdrawal paid", load: "Deposit to customer", adjust: "Admin deposit / withdrawal", purchase: "Purchase", refund: "Refund", withdraw: "Withdraw" };
  $("#ah").innerHTML = data.length ? data.map((t) => `<div class="list-item">
    <div class="grow"><b>${esc(label[t.type] || t.type)}</b><div class="small muted">${esc(t.description || "")}</div>
    <div class="small muted">${fmtDate(t.created_at)}</div></div>
    <div class="${t.amount >= 0 ? "amt-pos" : "amt-neg"}">${t.amount >= 0 ? "+" : "−"}${money(Math.abs(t.amount))}</div></div>`).join("")
    : `<div class="empty"><div class="big">🗂️</div>No activity yet</div>`;
}

/* -------- Agent's own profile -------- */
async function viewProfile(v) {
  const { data } = await sb.from("profiles").select("*").eq("id", A.me.id).single();
  const p = data || A.me;
  v.innerHTML = `<div class="card">
    <div class="row"><img src="img/logo.png" style="width:56px"><div class="grow"><h2 style="margin:0">${esc(p.full_name)}</h2>
      <div class="mono muted">${esc(p.member_id)} · <span class="badge ${p.role}">${p.role}</span></div></div></div>
    <div class="info-grid mt">
      ${[["Agent ID", p.member_id], ["Name", p.full_name], ["Phone", p.phone || "—"], ["Country", p.country || "—"], ["City", p.city || "—"], ["Street", p.street || "—"], ["Balance", money(p.balance)], ["Since", fmtDate(p.created_at)]]
        .map(([k, val]) => `<div><div class="k">${k}</div><div class="v">${esc(val)}</div></div>`).join("")}
    </div>
    <p class="small muted mt">To change your details or password, contact the admin.</p>
  </div>`;
}

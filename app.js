// The owner page. Sign-in is Supabase Auth: an email link, then a required
// authenticator code. Data comes only from the bookings function's
// /owner routes, which check the signed-in user is the owner at the second
// factor before reading anything. See docs/owner-page.md in
// wishing-stream-bookings.
//
// Nothing here is secret. The publishable key is designed to be public and
// reaches nothing on its own: every table is service-role only. Data is held
// in memory and never written to storage; every value from the server goes
// into the page as text, never as HTML.

import {
  addDays, bars, dueLabel, feedHealth, holdState, monthRange, nights, pipelineSummary, responseHours, shiftMonth,
  taskSummary, upcoming, whatsappLink,
} from "./calendar.js";

const SUPABASE_URL = "https://wqncpiokoaqwhpcwtawd.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_SWxWltcwoZF0SCcDfpTT0Q_ZNj2FSqR";
const OWNER_API = `${SUPABASE_URL}/functions/v1/bookings/owner`;

const sb = window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
  auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true },
});

const $ = (id) => document.getElementById(id);
const steps = ["step-email", "step-enrol", "step-code", "app"];
function show(id) {
  for (const s of steps) $(s).hidden = s !== id;
  $("sign-out").hidden = id === "step-email";
}
function say(text, kind = "") {
  $("status").textContent = text;
  $("status").className = `status ${kind}`;
}
function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "style") Object.assign(e.style, v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

// ---- sign-in ----

let enrolFactorId = null;

// Works out which step the current session is at and shows it. Called on load
// and whenever Supabase reports the session changed, and those overlap: the
// page loading from a sign-in link fires both at once. Two routes running
// together both saw no factor and both tried to enrol one, and the second
// failed on the duplicate name. So one runs at a time, and a call that arrives
// while one is running makes it look again once it has finished.
let routing = null;
let routeAgain = false;
function route() {
  if (routing) { routeAgain = true; return routing; }
  routing = (async () => {
    do { routeAgain = false; await routeOnce(); } while (routeAgain);
  })().finally(() => { routing = null; });
  return routing;
}

async function routeOnce() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { clearData(); show("step-email"); return; }

  const { data: aal, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) { say(error.message, "bad"); show("step-email"); return; }
  if (aal.currentLevel === "aal2") { show("app"); say(""); load(); return; }

  const { data: factors } = await sb.auth.mfa.listFactors();
  if (factors?.totp?.some((f) => f.status === "verified")) {
    show("step-code");
    $("code").focus();
  } else {
    await startEnrolment(factors);
  }
}

// First sign-in only. A half-finished earlier attempt leaves an unverified
// factor behind, and a new one cannot be enrolled beside it with the same
// name, so those are cleared first.
async function startEnrolment(factors) {
  // Already showing a QR code for a factor that still exists: keep it. A new
  // one would change the code under someone halfway through scanning it.
  const pending = (factors?.all ?? []).find((f) => f.id === enrolFactorId && f.status === "unverified");
  if (pending) { show("step-enrol"); return; }
  for (const f of factors?.all ?? []) {
    if (f.status === "unverified") await sb.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Owner page" });
  if (error) { say(`Could not start authenticator setup: ${error.message}`, "bad"); return; }
  enrolFactorId = data.id;
  $("qr").src = data.totp.qr_code;
  $("secret").textContent = data.totp.secret;
  show("step-enrol");
}

$("email-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  say("Sending…");
  const { error } = await sb.auth.signInWithOtp({
    email,
    // Never create an account from this form. Sign-ups are off in the project
    // too; this is the second lock on the same door.
    options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
  });
  // Say plainly when no link was sent. An earlier version gave the same
  // reassuring message either way, to avoid confirming which address is the
  // owner's; with one owner that protects nothing, and it hid the one failure
  // that matters: an invited account that has not accepted its invite is
  // treated as a new sign-up, and sign-ups are off.
  if (!error) {
    say("A sign-in link is on its way. Open it in this browser.");
  } else if (error.code === "signup_disabled" || /signups not allowed/i.test(error.message)) {
    say("No link was sent: this address cannot sign in yet. If you have been invited, " +
      "open the invite email and accept it first, then ask for a link again.", "bad");
  } else {
    say(`No link was sent: ${error.message}`, "bad");
  }
});

$("enrol-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.mfa.challengeAndVerify({
    factorId: enrolFactorId, code: $("enrol-code").value.trim(),
  });
  if (error) { say("That code did not match. Try the current one.", "bad"); return; }
  $("secret").textContent = "";
  $("qr").removeAttribute("src");
  route();
});

$("code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { data: factors } = await sb.auth.mfa.listFactors();
  const factor = factors?.totp?.find((f) => f.status === "verified");
  if (!factor) { route(); return; }
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: $("code").value.trim() });
  $("code").value = "";
  if (error) { say("That code did not match. Try the current one.", "bad"); return; }
  route();
});

$("sign-out").addEventListener("click", async () => {
  await sb.auth.signOut();
  clearData();
  say("Signed out.");
  show("step-email");
});

sb.auth.onAuthStateChange((event) => {
  // Deferred: calling back into auth from inside its own callback can wait on
  // itself.
  if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "MFA_CHALLENGE_VERIFIED") {
    setTimeout(route, 0);
  }
});

// ---- data ----

let month = null;
let names = new Map();

async function api(path) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("Signed out.");
  const res = await fetch(`${OWNER_API}${path}`, {
    headers: { authorization: `Bearer ${session.access_token}` },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { await sb.auth.signOut(); throw new Error(body.error ?? "Signed out."); }
  if (!res.ok) throw new Error(body.error ?? `The server said ${res.status}.`);
  return body;
}

function clearData() {
  for (const id of ["upcoming", "grid", "feeds", "quarters", "gites", "kinds", "kept", "review", "guest-list", "past-list",
    "enquiry-list", "direct-list", "gap-list", "task-list"]) $(id).replaceChildren();
  $("todo-prompt").textContent = "";
  $("todo").open = false;
  $("guests-prompt").textContent = "";
  $("pipeline-prompt").textContent = "";
  $("reply-time").textContent = "";
  $("pipeline").open = false;
  $("guests").open = false;
  guestData = null;
  $("bankcheck").textContent = "";
  $("money").open = false;
  moneyYear = null;
  $("month-title").textContent = "";
  names = new Map();
}

async function load() {
  try {
    // The next two weeks first: one day either side of today catches a guest
    // leaving this morning, whose last night was yesterday.
    const soon = await api(`/bookings?from=${addDaysToday(-1)}&to=${addDaysToday(15)}`);
    names = new Map(soon.properties.map((p) => [p.slug, p.name]));
    month ??= soon.today.slice(0, 7);
    today = soon.today;
    renderUpcoming(upcoming(soon.stays, soon.today, 14));
    await loadMonth();
    const { feeds } = await api("/feeds");
    renderFeeds(feeds);
    await loadTasks();
    await loadPipeline();
    await loadGuests();
  } catch (e) {
    say(e.message, "bad");
  }
}

let today = new Date().toISOString().slice(0, 10);
function addDaysToday(n) { return addDays(today, n); }

async function loadMonth() {
  const r = monthRange(month);
  const data = await api(`/bookings?from=${r.from}&to=${r.to}`);
  names = new Map(data.properties.map((p) => [p.slug, p.name]));
  renderMonth(r, data);
}

// ---- rendering ----

const dateFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const monthFmt = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const dateFmtYear = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
// The year only when it is not this year: next summer's bookings are already
// in, and "Mon 19 Jul" alone would read as this July.
const fmtDate = (d) => (d.slice(0, 4) === today.slice(0, 4) ? dateFmt : dateFmtYear).format(new Date(`${d}T00:00:00Z`));

function renderUpcoming(events) {
  const list = $("upcoming");
  list.replaceChildren();
  if (events.length === 0) {
    list.append(el("li", { class: "empty" }, "No guests arriving or leaving in the next two weeks."));
    return;
  }
  const label = { arrive: "Arrival", leave: "Departure", turnover: "Turnover — out and in the same day" };
  for (const e of events) {
    list.append(el("li", { class: `ev ev-${e.kind}` },
      el("span", { class: "ev-date" }, e.date === today ? "Today" : fmtDate(e.date)),
      el("span", { class: "ev-prop" }, names.get(e.property) ?? e.property),
      el("span", { class: "ev-kind" }, label[e.kind])));
  }
}

function renderMonth(r, data) {
  $("month-title").textContent = monthFmt.format(new Date(`${r.from}T00:00:00Z`));
  const grid = $("grid");
  grid.replaceChildren();
  grid.style.setProperty("--days", r.days.length);

  // Header row: day numbers, weekends and today marked.
  const head = el("div", { class: "row head", role: "row" }, el("div", { class: "name", role: "columnheader" }));
  for (const d of r.days) {
    const cls = ["day", d.dow === 0 || d.dow === 6 ? "weekend" : "", d.date === data.today ? "today" : ""].join(" ");
    head.append(el("div", { class: cls, role: "columnheader", title: fmtDate(d.date) }, String(d.day)));
  }
  grid.append(head);

  const turnovers = new Set(data.turnovers.map((t) => `${t.property}|${t.date}`));

  for (const p of data.properties) {
    const row = el("div", { class: "row", role: "row" }, el("div", { class: "name", role: "rowheader" }, p.name));
    // Background cells, so weekends and today line up under the header.
    for (const d of r.days) {
      const cls = ["cell", d.dow === 0 || d.dow === 6 ? "weekend" : "", d.date === data.today ? "today" : ""].join(" ");
      row.append(el("div", { class: cls, style: { gridColumn: `${d.day + 1}` } }));
    }
    for (const b of bars(data.stays.filter((s) => s.property === p.slug), r.from, r.to)) {
      // A direct hold is dates promised, not a guest; a confirmed direct
      // booking is a guest the owner took, and must also be blocked on Vrbo.
      const kind = b.status === "blocked" ? "block"
        : b.channel === "direct" ? (b.status === "tentative" ? "hold" : "direct") : "guest";
      const turn = turnovers.has(`${p.slug}|${b.checkin}`) && !b.clippedStart;
      const cls = ["bar", `bar-${kind}`, b.clippedStart ? "clip-start" : "", b.clippedEnd ? "clip-end" : "",
        turn ? "turn" : ""].join(" ");
      const n = Math.round((Date.parse(b.checkout) - Date.parse(b.checkin)) / 86_400_000);
      const what = { block: "Owner block", hold: "Hold (direct, not confirmed)", direct: "Direct booking", guest: "Guest stay" }[kind];
      const text = `${what}: ${fmtDate(b.checkin)} → ${fmtDate(b.checkout)}, ${n} night${n === 1 ? "" : "s"}` +
        (turn ? ". Same-day turnover on arrival." : "");
      row.append(el("div", {
        class: cls, role: "cell", title: text, "aria-label": text,
        style: { gridColumn: `${b.start + 1} / span ${b.span}` },
      }, b.span >= 3 ? el("span", {}, kind === "block" ? "Block" : kind === "hold" ? "Hold" : `${n}n`) : null));
    }
    grid.append(row);
  }

  // On a narrow screen the month does not fit, so start the scroll at the
  // week before today rather than at the 1st.
  const scroller = grid.parentElement;
  const todayCell = head.querySelector(".day.today");
  scroller.scrollLeft = todayCell
    ? Math.max(0, todayCell.offsetLeft - grid.querySelector(".name").offsetWidth - todayCell.offsetWidth * 7)
    : 0;
}

const ago = (iso) => {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  // A device clock a little ahead of the server's must not say "−3 min ago".
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};

function renderFeeds(feeds) {
  const list = $("feeds");
  list.replaceChildren();
  const label = { ok: "OK", stale: "Stale", failing: "Failing", never: "Never synced", inactive: "Off" };
  for (const f of feeds) {
    const h = feedHealth(f, Date.now());
    list.append(el("li", { class: `feed feed-${h}` },
      el("span", { class: "feed-name" }, f.name ?? f.property),
      el("span", { class: "feed-state" }, label[h]),
      el("span", { class: "feed-when" }, `Last success ${ago(f.last_success_at)}`),
      f.last_error ? el("span", { class: "feed-error" }, f.last_error) : null));
  }
}

// ---- to do (O5) ----

async function loadTasks() {
  try {
    const t = await api("/tasks");
    renderTasks(t.tasks, t.today);
  } catch (e) {
    say(e.message, "bad");
  }
}

// Which contact a task needs: email for the welcome email and the review
// request, the phone for the WhatsApps.
const NEEDS = { welcome_email: "email", review_request: "email", welcome_message: "phone", goodbye_message: "phone",
  notify_caretaker: null };

function renderTasks(tasks, today) {
  const sum = taskSummary(tasks, today);
  $("todo-prompt").textContent = sum.text;
  $("todo-prompt").className = `hint-inline ${sum.urgent ? "prompt" : ""}`;
  const list = $("task-list");
  list.replaceChildren();
  if (!tasks.length) list.append(el("li", { class: "empty" }, "Nothing due in the next 30 days."));
  for (const t of tasks) {
    const g = t.guest;
    const need = NEEDS[t.kind];
    const actions = el("div", { class: "t-actions" });
    if (need === "email" && g?.email) actions.append(el("a", { href: `mailto:${g.email}` }, g.email));
    if (need === "phone" && g?.phone) {
      const wa = whatsappLink(g.phone);
      if (wa) actions.append(el("a", { href: wa, target: "_blank", rel: "noopener noreferrer" }, "WhatsApp"));
      actions.append(el("a", { href: `tel:${g.phone}` }, g.phone));
    }
    if (need && !g?.[need]) actions.append(el("span", { class: "t-missing" }, `No ${need} on file — add it under Guests`));
    const msg = el("span", { class: "g-msg", role: "status" });
    const draftBox = el("div", { class: "t-draft", hidden: "" });
    if (need) {
      const btn = el("button", { type: "button", class: "link" }, "Draft");
      btn.addEventListener("click", () => showDraft(t, g, draftBox, btn));
      actions.append(btn);
    }
    for (const [status, label] of [["done", "Done"], ["skipped", "Skip"]]) {
      const btn = el("button", { type: "button", class: status === "done" ? "" : "link" }, label);
      btn.addEventListener("click", () => setTask(t.id, status, btn, msg));
      actions.append(btn);
    }
    actions.append(msg);
    const due = t.due_on < today ? "overdue" : t.due_on === today ? "today" : "";
    list.append(el("li", {},
      el("div", { class: "g-head" },
        el("span", { class: "g-name" }, `${t.label} — ${g?.name ?? "guest not known yet"}`),
        el("span", { class: `t-due ${due}` }, dueLabel(t.due_on, today, fmtDate))),
      el("div", { class: "g-when" }, `${t.gite} · ${fmtDate(t.checkin)} → ${fmtDate(t.checkout)}` +
        (t.channel === "direct" ? " · direct" : "")),
      t.same_day_arrival && t.kind.startsWith("welcome")
        ? el("div", { class: "t-flag" }, "Same-day turnover on arrival: the gîte is cleaned in hours") : null,
      t.kind === "goodbye_message" ? el("div", { class: "g-meta" }, `Turnover after: ${t.turnover_by}`) : null,
      actions, draftBox));
  }
}

// The message, drafted in the owner's wording, to read, edit and send from
// his own email or WhatsApp. The email link carries the draft into his mail
// app; nothing is sent from the page. Gaps such as the welcome pack password
// are marked in [brackets] for him to fill.
async function showDraft(t, g, box, btn) {
  if (!box.hidden) { box.hidden = true; return; }
  btn.disabled = true;
  try {
    const d = await api(`/tasks/${t.id}/draft`);
    const text = el("textarea", { rows: String(Math.min(16, d.body.split("\n").length + 2)), "aria-label": "Draft message" });
    text.value = d.body;
    const copy = el("button", { type: "button" }, "Copy");
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(text.value);
      copy.textContent = "Copied";
    });
    const bits = [d.subject ? el("div", { class: "g-meta" }, `Subject: ${d.subject}`) : null, text, el("div", { class: "t-actions" }, copy)];
    if (d.channel === "email" && g?.email) {
      const href = `mailto:${g.email}?subject=${encodeURIComponent(d.subject ?? "")}&body=${encodeURIComponent(text.value)}`;
      const open = el("a", { href }, "Open in mail");
      text.addEventListener("input", () => {
        open.href = `mailto:${g.email}?subject=${encodeURIComponent(d.subject ?? "")}&body=${encodeURIComponent(text.value)}`;
      });
      bits[2].append(open);
    }
    if (text.value.includes("[")) bits.push(el("div", { class: "t-missing" }, "Fill in the [bracketed] gaps before sending."));
    box.replaceChildren(...bits.filter(Boolean));
  } catch (e) {
    box.replaceChildren(el("div", { class: "t-missing" }, e.message));
  }
  box.hidden = false;
  btn.disabled = false;
}

async function setTask(id, status, btn, msg) {
  btn.disabled = true;
  msg.textContent = "Saving…";
  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(`${OWNER_API}/tasks/${id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) { msg.textContent = r.error ?? `Not saved (${res.status}).`; btn.disabled = false; return; }
    await loadTasks();
  } catch (e) {
    msg.textContent = e.message;
    btn.disabled = false;
  }
}

// ---- enquiries, holds and gaps (O4) ----

const SOURCE = { site: "the website", email: "email", phone: "phone", whatsapp: "WhatsApp", vrbo: "Vrbo message",
  in_person: "in person", other: "—" };
const ENQ_STATE = { new: "To answer", responded: "Waiting on guest", converted: "Booked", lost: "Lost", spam: "Spam" };
const HOLD_STATE = { open: "Hold, no end date", lapsed: "Hold lapsed", soon: "Hold ends soon", ok: "Hold" };

async function loadPipeline() {
  try {
    renderPipeline(await api("/pipeline"));
  } catch (e) {
    say(e.message, "bad");
  }
}

function party(adults, children) {
  if (!adults) return null;
  return `${adults} adult${adults === 1 ? "" : "s"}${children ? `, ${children} child${children === 1 ? "" : "ren"}` : ""}`;
}

function renderPipeline(p) {
  const sum = pipelineSummary(p, p.today);
  $("pipeline-prompt").textContent = sum.text;
  $("pipeline-prompt").className = `hint-inline ${sum.urgent ? "prompt" : ""}`;

  // Average time to a first answer, over the enquiries that have one.
  const answered = p.enquiries.filter((e) => e.responded_at);
  $("reply-time").textContent = answered.length
    ? `Average time to answer: ${Math.round(answered.reduce((s, e) => s + responseHours(e.received_at, e.responded_at, 0), 0) / answered.length)} h, over ${answered.length}.`
    : "";

  const now = Date.now();
  const enq = $("enquiry-list");
  enq.replaceChildren();
  if (!p.enquiries.length) enq.append(el("li", { class: "empty" }, "No open enquiries, and none closed in the last 90 days."));
  for (const e of p.enquiries) {
    const when = e.checkin ? `${fmtDate(e.checkin)} → ${fmtDate(e.checkout)}` : "dates not given";
    const wait = e.status === "new" ? `waiting ${responseHours(e.received_at, null, now)} h` :
      e.responded_at ? `answered in ${responseHours(e.received_at, e.responded_at, 0)} h` : null;
    enq.append(el("li", {},
      el("div", { class: "g-head" },
        el("span", { class: "g-name" }, e.guest ?? "Guest not recorded"),
        el("span", { class: `state ${e.status}` }, ENQ_STATE[e.status] ?? e.status)),
      el("div", { class: "g-when" }, `${when} · ${e.gite ?? "any gîte"}`),
      el("div", { class: "g-meta" },
        party(e.adults, e.children),
        `via ${SOURCE[e.source] ?? e.source}`,
        wait,
        e.quoted_price ? `quoted €${Number(e.quoted_price).toLocaleString("en-GB", { minimumFractionDigits: 2 })}` : null,
        e.lost_reason ? e.lost_reason : null)));
  }

  const dl = $("direct-list");
  dl.replaceChildren();
  if (!p.direct.length) dl.append(el("li", { class: "empty" }, "No direct bookings or holds."));
  for (const d of p.direct) {
    const hs = d.status === "tentative" ? holdState(d.hold_expires_on, p.today) : "confirmed";
    const label = d.status === "tentative"
      ? HOLD_STATE[hs] + (d.hold_expires_on ? ` until ${fmtDate(d.hold_expires_on)}` : "")
      : "Confirmed";
    dl.append(el("li", {},
      el("div", { class: "g-head" },
        el("span", { class: "g-name" }, d.guest ?? "Guest not recorded"),
        el("span", { class: `state ${hs}` }, label)),
      el("div", { class: "g-when" }, `${fmtDate(d.checkin)} → ${fmtDate(d.checkout)} · ${d.gite} · ${nights(d.checkin, d.checkout)} nights`),
      el("div", { class: "g-meta" }, party(d.adults, d.children), el("span", { class: "g-ref" }, d.reservation))));
  }

  const gl = $("gap-list");
  gl.replaceChildren();
  if (!p.gaps.length) gl.append(el("li", { class: "empty" }, "No short gaps."));
  for (const g of p.gaps) {
    gl.append(el("li", {},
      el("div", { class: "g-head" },
        el("span", { class: "g-name" }, g.gite),
        el("span", { class: "g-when" }, `${g.nights} night${g.nights === 1 ? "" : "s"}`)),
      el("div", { class: "g-when" }, `${fmtDate(g.from)} → ${fmtDate(g.to)}`)));
  }
}

// ---- guests (O2) ----

let guestData = null;

async function loadGuests() {
  try {
    guestData = await api("/guests");
    renderGuests();
  } catch (e) {
    say(e.message, "bad");
  }
}

function renderGuests() {
  if (!guestData) return;
  const { today, stays } = guestData;
  const upcoming = stays.filter((s) => s.checkout >= today);
  const missing = upcoming.filter((s) => s.guest && !s.guest.email).length;
  const unknown = upcoming.filter((s) => !s.guest).length;
  const bits = [];
  if (missing) bits.push(`${missing} upcoming guest${missing === 1 ? "" : "s"} need${missing === 1 ? "s" : ""} an email`);
  if (unknown) bits.push(`${unknown} stay${unknown === 1 ? "" : "s"} with no guest details yet`);
  $("guests-prompt").textContent = bits.join(" · ") || "all upcoming guests have an email";
  $("guests-prompt").className = `hint-inline ${missing ? "prompt" : ""}`;

  const list = $("guest-list");
  list.replaceChildren();
  // Upcoming and current stays first, soonest at the top, with the prompt.
  if (upcoming.length === 0) list.append(el("li", { class: "empty" }, "No upcoming stays."));
  for (const s of upcoming) list.append(guestItem(s));

  // Past guests: everyone who has stayed, most recent first, no prompt — Vrbo
  // removes the email after a stay — but an email can still be added.
  const past = stays.filter((s) => s.checkout < today && s.guest).reverse();
  $("past-count").textContent = past.length ? `${past.length}` : "none yet";
  const pl = $("past-list");
  pl.replaceChildren();
  for (const s of past) pl.append(guestItem(s));
}

function guestItem(s) {
    const g = s.guest;
    const li = el("li", {},
      el("div", { class: "g-head" },
        el("span", { class: "g-name" }, g?.name ?? "Guest not known yet"),
        el("span", { class: "g-when" }, `${fmtDate(s.checkin)} → ${fmtDate(s.checkout)} · ${s.gite}`)),
      el("div", { class: "g-meta" },
        s.party ? `${s.party} guests` : null,
        s.reservation ? el("span", { class: "g-ref" }, s.reservation) : null));
    if (g?.phone) {
      li.append(el("a", { class: "g-phone", href: `tel:${g.phone}` }, g.phone));
    }
    if (g) li.append(contactForm(g));
    return li;
}

// An email field when the guest has none (and a phone field when Vrbo gave
// none); otherwise the email, as text. Saved through the owner route.
function contactForm(g) {
  if (g.email && g.phone) return el("div", { class: "g-email" }, g.email);
  const form = el("form", { class: "g-form" });
  const fields = [];
  if (g.email) form.append(el("div", { class: "g-email" }, g.email));
  else {
    const i = el("input", { type: "email", placeholder: "Guest's email", autocomplete: "off", "aria-label": `Email for ${g.name ?? "guest"}` });
    fields.push(["email", i]);
    form.append(i);
  }
  if (!g.phone) {
    const i = el("input", { type: "tel", placeholder: "Phone, with country code", autocomplete: "off", "aria-label": `Phone for ${g.name ?? "guest"}` });
    fields.push(["phone", i]);
    form.append(i);
  }
  const btn = el("button", { type: "submit" }, "Save");
  const msg = el("span", { class: "g-msg", role: "status" });
  form.append(btn, msg);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {};
    for (const [k, i] of fields) if (i.value.trim()) body[k] = i.value.trim();
    if (!Object.keys(body).length) { msg.textContent = "Nothing to save."; return; }
    btn.disabled = true;
    msg.textContent = "Saving…";
    try {
      const { data: { session } } = await sb.auth.getSession();
      const res = await fetch(`${OWNER_API}/guests/${g.id}/contact`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { msg.textContent = r.error ?? `Not saved (${res.status}).`; btn.disabled = false; return; }
      if (r.email) g.email = r.email;
      if (r.phone) g.phone = r.phone;
      renderGuests();
    } catch (err) {
      msg.textContent = err.message;
      btn.disabled = false;
    }
  });
  return form;
}

// ---- money (O3) ----

let moneyYear = null;
const eur = (cents) => {
  const sign = cents < 0 ? "−" : "";
  const a = Math.abs(cents);
  return `${sign}€${Math.floor(a / 100).toLocaleString("en-GB")}.${String(a % 100).padStart(2, "0")}`;
};
const eurWhole = (n) => `€${n.toLocaleString("en-GB")}`;
const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

async function loadMoney() {
  try {
    const m = await api(`/money?year=${moneyYear ?? ""}`);
    moneyYear = m.year;
    renderMoney(m);
  } catch (e) {
    say(e.message, "bad");
  }
}

function renderMoney(m) {
  $("money-year").textContent = String(m.year);
  const tbody = $("quarters");
  tbody.replaceChildren();
  const current = m.today.startsWith(String(m.year)) ? Math.floor((Number(m.today.slice(5, 7)) - 1) / 3) + 1 : 0;
  for (const q of m.quarters) {
    const empty = q.lines === 0;
    const label = `Q${q.quarter}` + (q.quarter === current ? " (so far)" : "");
    tbody.append(el("tr", { class: empty ? "empty-row" : "" },
      el("th", { scope: "row" }, label),
      el("td", {}, empty ? "—" : eur(q.lmtc)),
      el("td", { class: "declare" }, empty ? "—" : eurWhole(q.declare)),
      el("td", {}, empty ? "—" : (q.unclassified ? eur(q.unclassified) : "none")),
      el("td", { class: "net-col" }, empty ? "—" : eur(q.net))));
  }
  const list = $("gites");
  list.replaceChildren();
  for (const p of m.properties) {
    const c = p.classification;
    list.append(el("li", {},
      el("span", { class: "gite-name" }, p.name),
      el("span", { class: `badge ${c ? "classified" : "unclassified"}` },
        c ? `${c.stars}★ until ${dayFmt.format(new Date(`${c.expires_on}T00:00:00Z`))}` : "Unclassified"),
      el("span", { class: "gite-sum" }, `${eur(p.gross)} gross · ${eur(p.net)} net`)));
  }
  renderCosts(m.costs);
  renderKept(m.kept);
  const b = m.bank;
  $("bankcheck").textContent = b.lines === 0 ? "" : b.matched === b.lines
    ? `✓ All ${b.lines} Vrbo payments this year have been seen arriving in the bank.`
    : `${b.lines - b.matched} of ${b.lines} Vrbo payments (${eur(b.unmatched_net)}) not yet seen in the bank. ` +
      "Import a newer statement to check them.";
  $("bankcheck").className = `bankcheck ${b.matched === b.lines ? "ok" : "pending"}`;
}

// Earned, spent, taxed, kept; then drawn to the UK and still held in France.
// Tax owed but not yet paid is shown beside kept, not taken off it: the money
// is still in the account until the debit. Jersey tax stays in pounds.
function renderKept(k) {
  const list = $("kept");
  list.replaceChildren();
  if (!k || (k.income === 0 && k.costs === 0)) {
    list.append(el("li", { class: "empty" }, "Nothing to show until the year's bank statements are in."));
    return;
  }
  const row = (label, cents, cls = "") =>
    el("li", { class: cls }, el("span", {}, label), el("span", { class: "amt" }, eur(cents)));
  list.append(
    row("Money in", k.income),
    row("Gîte costs", -k.costs),
    row("French tax paid", -k.taxPaid),
    row("Kept", k.kept, "kept-total"),
    row("of which drawn to the UK", -k.drawn),
    row("still held in France", k.held));
  if (k.owedUnpaid) list.append(row("French tax owed, not yet paid", -k.owedUnpaid, "owed"));
  if (k.jerseyGbp) {
    list.append(el("li", {}, el("span", {}, "Jersey income tax, the gîtes' share"),
      el("span", { class: "amt" }, `−£${Math.floor(k.jerseyGbp / 100).toLocaleString("en-GB")}.${String(k.jerseyGbp % 100).padStart(2, "0")}`)));
  }
}

const KIND_LABEL = { income: "Money in", cost: "Gîte costs", tax: "Tax", personal: "Personal (family holiday)", transfer: "Between the two accounts", drawings: "Drawn to the UK" };

function renderCosts(c) {
  const list = $("kinds");
  list.replaceChildren();
  $("review").replaceChildren();
  $("review-wrap").hidden = true;
  if (!c || c.totals.length === 0) {
    list.append(el("li", { class: "empty" }, "No bank statements imported for this year."));
    return;
  }
  for (const kind of ["income", "cost", "tax", "personal", "transfer", "drawings"]) {
    const rows = c.totals.filter((t) => t.kind === kind);
    if (!rows.length) continue;
    const sum = rows.reduce((s, r) => s + r.cents, 0);
    const details = el("details", { class: "kind" },
      el("summary", {}, el("span", {}, KIND_LABEL[kind]), el("span", { class: "amt" }, eur(sum))));
    const inner = el("ul", {});
    for (const r of rows) {
      inner.append(el("li", {}, el("span", {}, `${r.label} (${r.count})`), el("span", { class: "amt" }, eur(r.cents))));
    }
    details.append(inner);
    list.append(el("li", {}, details));
  }
  if (c.review.length) {
    $("review-wrap").hidden = false;
    for (const r of c.review) {
      $("review").append(el("li", {},
        el("span", { class: "rv-date" }, fmtDate(r.date)),
        el("span", { class: "amt" }, eur(r.amount)),
        el("span", { class: "rv-desc" }, r.description),
        el("span", { class: "rv-why" }, r.reason)));
    }
  }
}

// Every year, newest first: gross, Vrbo's fees and net, opening to each gîte.
// In euros. Vrbo paid in pounds until 2019; those years are converted at the
// owner's flat rate, and the year says how many pounds that was.
const CUR = { EUR: "€", GBP: "£" };
const amount = (cents, cur = "EUR") => {
  const sign = cents < 0 ? "−" : "";
  const a = Math.abs(cents);
  return `${sign}${CUR[cur] ?? `${cur} `}${Math.floor(a / 100).toLocaleString("en-GB")}`;
};

async function loadYears() {
  try {
    renderYears(await api("/history"));
  } catch (e) {
    say(e.message, "bad");
  }
}

function renderYears(h) {
  const list = $("years");
  list.replaceChildren();
  if (!h.years.length) {
    list.append(el("li", { class: "empty" }, "No payouts imported yet."));
    return;
  }
  const thisYear = Number(h.today.slice(0, 4));
  for (const y of h.years) {
    const label = `${y.year}${y.year === thisYear ? " (so far)" : ""}${y.converted.length ? " *" : ""}`;
    const details = el("details", { class: "kind" },
      el("summary", {}, el("span", {}, label),
        el("span", { class: "amt" }, `${amount(y.gross)} gross · ${amount(y.net)} net`)));
    const inner = el("ul", {});
    for (const p of h.properties) {
      const a = y.properties[p.slug];
      if (!a) continue;
      inner.append(el("li", {}, el("span", {}, p.name), el("span", { class: "amt" }, amount(a.gross))));
    }
    inner.append(el("li", {}, el("span", {}, "Vrbo's fees"), el("span", { class: "amt" }, amount(-y.deductions))));
    for (const c of y.converted) {
      inner.append(el("li", {}, el("span", {}, `* includes ${amount(c.gross, c.currency)} gross paid in pounds, at ${c.currency} 1 = €${c.rate}`)));
    }
    details.append(inner);
    list.append(el("li", {}, details));
  }
  // A currency with no agreed rate is shown as it was paid, never guessed.
  for (const y of h.unconverted ?? []) {
    list.append(el("li", {}, el("span", {}, `${y.year}, paid in ${y.currency}: `),
      el("span", { class: "amt" }, `${amount(y.gross, y.currency)} gross · ${amount(y.net, y.currency)} net`)));
  }
}

$("money").addEventListener("toggle", () => { if ($("money").open) { loadYears(); loadMoney(); } });
$("money-prev").addEventListener("click", () => { moneyYear -= 1; loadMoney(); });
$("money-next").addEventListener("click", () => { moneyYear += 1; loadMoney(); });

$("prev").addEventListener("click", () => { month = shiftMonth(month, -1); loadMonth().catch((e) => say(e.message, "bad")); });
$("next").addEventListener("click", () => { month = shiftMonth(month, 1); loadMonth().catch((e) => say(e.message, "bad")); });
$("this-month").addEventListener("click", () => { month = today.slice(0, 7); loadMonth().catch((e) => say(e.message, "bad")); });

route();

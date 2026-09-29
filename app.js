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

import { addDays, bars, feedHealth, monthRange, shiftMonth, upcoming } from "./calendar.js";

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
// and whenever Supabase reports the session changed.
async function route() {
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
  for (const id of ["upcoming", "grid", "feeds"]) $(id).replaceChildren();
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
const fmtDate = (d) => dateFmt.format(new Date(`${d}T00:00:00Z`));

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
      const kind = b.status === "blocked" ? "block" : "guest";
      const turn = turnovers.has(`${p.slug}|${b.checkin}`) && !b.clippedStart;
      const cls = ["bar", `bar-${kind}`, b.clippedStart ? "clip-start" : "", b.clippedEnd ? "clip-end" : "",
        turn ? "turn" : ""].join(" ");
      const n = Math.round((Date.parse(b.checkout) - Date.parse(b.checkin)) / 86_400_000);
      const what = kind === "block" ? "Owner block" : "Guest stay";
      const text = `${what}: ${fmtDate(b.checkin)} → ${fmtDate(b.checkout)}, ${n} night${n === 1 ? "" : "s"}` +
        (turn ? ". Same-day turnover on arrival." : "");
      row.append(el("div", {
        class: cls, role: "cell", title: text, "aria-label": text,
        style: { gridColumn: `${b.start + 1} / span ${b.span}` },
      }, b.span >= 3 ? el("span", {}, kind === "block" ? "Block" : `${n}n`) : null));
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

$("prev").addEventListener("click", () => { month = shiftMonth(month, -1); loadMonth().catch((e) => say(e.message, "bad")); });
$("next").addEventListener("click", () => { month = shiftMonth(month, 1); loadMonth().catch((e) => say(e.message, "bad")); });
$("this-month").addEventListener("click", () => { month = today.slice(0, 7); loadMonth().catch((e) => say(e.message, "bad")); });

route();

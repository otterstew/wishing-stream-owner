// The owner page's calendar arithmetic. Pure: no DOM, no network, so it can be
// tested with Deno (tests/calendar_test.js).
//
// Stays are calendar days, never instants. `checkout` is the day the guest
// leaves and is exclusive: a stay 12 → 19 sleeps the nights of the 12th to the
// 18th. Every date here is a YYYY-MM-DD string and all arithmetic is in UTC,
// so a clock change can never move a stay by a day.

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function nights(checkin, checkout) {
  return Math.round((Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) / 86_400_000);
}

// "2026-10" → the month's days and its query bounds: from inclusive, to
// exclusive, which is exactly what the owner routes take.
export function monthRange(ym) {
  const from = `${ym}-01`;
  const to = shiftMonth(ym, 1) + "-01";
  const days = [];
  for (let d = from; d < to; d = addDays(d, 1)) {
    days.push({ date: d, day: Number(d.slice(8)), dow: new Date(`${d}T00:00:00Z`).getUTCDay() });
  }
  return { from, to, days };
}

export function shiftMonth(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

// Where each stay sits in a grid whose columns are the nights of [from, to).
// `start` is the 1-based column of its first night in view and `span` how many
// nights it shows. A stay that began before the month or runs past it is
// clipped, and says so, so the page can draw a flat edge instead of a rounded
// one: a bar that looks like it starts on the 1st must not be mistaken for an
// arrival on the 1st.
export function bars(stays, from, to) {
  const out = [];
  for (const s of stays) {
    if (!(s.checkin < to && s.checkout > from)) continue;
    const first = s.checkin < from ? from : s.checkin;
    const end = s.checkout > to ? to : s.checkout;
    out.push({
      ...s,
      start: nights(from, first) + 1,
      span: nights(first, end),
      clippedStart: s.checkin < from,
      clippedEnd: s.checkout > to,
    });
  }
  return out;
}

// What happens in the next `days` days, starting today, as a list to read
// rather than a grid to decode. Guest stays only: an owner block has no one
// arriving. A departure and an arrival on the same day at the same property
// are one line, a turnover, because that is one job, not two.
export function upcoming(stays, today, days) {
  const end = addDays(today, days);
  const guests = stays.filter((s) => s.status === "confirmed");
  const events = new Map();
  const put = (property, date, kind) => {
    if (date < today || date >= end) return;
    const key = `${date}|${property}`;
    const prev = events.get(key);
    const merged = prev && prev.kind !== kind ? "turnover" : kind;
    events.set(key, { date, property, kind: merged });
  };
  for (const s of guests) {
    put(s.property, s.checkout, "leave");
    put(s.property, s.checkin, "arrive");
  }
  return [...events.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || a.property.localeCompare(b.property));
}

// A feed is stale when its last success is more than `maxDays` ago, or it has
// never succeeded. The gap between last attempt and last success is how a feed
// that has been failing quietly becomes visible. The scheduled sync runs every
// three hours, so a day without a success is eight missed runs, not a quiet
// week.
export function feedHealth(feed, now, maxDays = 1) {
  if (!feed.active) return "inactive";
  if (!feed.last_success_at) return "never";
  const age = (now - Date.parse(feed.last_success_at)) / 86_400_000;
  if (feed.last_status && !["ok", "not_modified"].includes(feed.last_status)) return "failing";
  return age > maxDays ? "stale" : "ok";
}

// ---- enquiries, holds and gaps (O4) ----

// Where a hold stands on `today`. A hold is direct dates kept for a guest who
// has not confirmed; nothing releases it automatically, so a lapsed one has
// to be seen. "soon" is three days or less: time to chase the guest.
export function holdState(expiresOn, today) {
  if (!expiresOn) return "open";
  if (expiresOn < today) return "lapsed";
  return nights(today, expiresOn) <= 3 ? "soon" : "ok";
}

// Hours from an enquiry arriving to its first answer, or so far when it has
// none. Time-to-response is the cheapest lever direct booking has.
export function responseHours(receivedAt, respondedAt, now) {
  const end = respondedAt ? Date.parse(respondedAt) : now;
  return Math.max(0, Math.round((end - Date.parse(receivedAt)) / 3_600_000));
}

// The section heading: what is waiting on the owner, in a few words. Empty
// parts are left out; nothing waiting says so.
export function pipelineSummary(p, today) {
  const unanswered = p.enquiries.filter((e) => e.status === "new").length;
  const waiting = p.enquiries.filter((e) => e.status === "responded").length;
  const holds = p.direct.filter((d) => d.status === "tentative");
  const lapsed = holds.filter((h) => holdState(h.hold_expires_on, today) === "lapsed").length;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const bits = [];
  if (unanswered) bits.push(plural(unanswered, "enquiry to answer", "enquiries to answer"));
  if (waiting) bits.push(plural(waiting, "waiting on the guest", "waiting on guests"));
  if (holds.length) bits.push(plural(holds.length, "hold", "holds") + (lapsed ? ` (${lapsed} lapsed)` : ""));
  if (p.gaps.length) bits.push(plural(p.gaps.length, "short gap", "short gaps"));
  return { text: bits.join(" · ") || "nothing waiting", urgent: unanswered > 0 || lapsed > 0 };
}

// ---- stay tasks (O5) ----

// "Overdue by 2 days", "Today", "Tomorrow", "In 5 days", "Mon 3 Aug" beyond a
// fortnight. Calendar days, so a task due today is never "overdue by 0".
export function dueLabel(due, today, fmt) {
  const n = nights(today, due);
  if (n < 0) return `Overdue by ${-n} day${n === -1 ? "" : "s"}`;
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n <= 14) return `In ${n} days`;
  return fmt ? fmt(due) : due;
}

// The section heading: overdue and due-this-week counts, or that nothing is.
export function taskSummary(tasks, today) {
  const overdue = tasks.filter((t) => t.due_on < today).length;
  const week = tasks.filter((t) => t.due_on >= today && nights(today, t.due_on) < 7).length;
  const bits = [];
  if (overdue) bits.push(`${overdue} overdue`);
  if (week) bits.push(`${week} due this week`);
  if (!bits.length) bits.push(tasks.length ? `next in ${nights(today, tasks[0].due_on)} days` : "nothing due");
  return { text: bits.join(" · "), urgent: overdue > 0 };
}

// A WhatsApp link from an E.164 phone: wa.me wants the digits only.
export function whatsappLink(phone) {
  return /^\+[1-9]\d{6,14}$/.test(phone ?? "") ? `https://wa.me/${phone.slice(1)}` : null;
}

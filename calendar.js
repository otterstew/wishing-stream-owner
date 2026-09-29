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
// that has been failing quietly becomes visible.
export function feedHealth(feed, now, maxDays = 7) {
  if (!feed.active) return "inactive";
  if (!feed.last_success_at) return "never";
  const age = (now - Date.parse(feed.last_success_at)) / 86_400_000;
  if (feed.last_status && !["ok", "not_modified"].includes(feed.last_status)) return "failing";
  return age > maxDays ? "stale" : "ok";
}

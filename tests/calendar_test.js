// Tests for the calendar arithmetic.
//
//   deno run --no-config tests/calendar_test.js
//
// Checkout is exclusive and never adjusted; a stay that crosses a month edge
// must be clipped, not moved; and a same-day departure and arrival is one
// turnover, not two lines.

import { addDays, bars, feedHealth, holdState, monthRange, nights, pipelineSummary, responseHours, shiftMonth, upcoming } from "../calendar.js";

let pass = 0, fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`FAIL ${label}\n  got  ${g}\n  want ${w}`); }
}

const s = (property, checkin, checkout, status = "confirmed") => ({ property, checkin, checkout, status });

// ---- dates ----
eq("nights: a week", nights("2026-08-12", "2026-08-19"), 7);
eq("nights: across the October clock change", nights("2026-10-24", "2026-10-26"), 2);
eq("addDays: into a leap day", addDays("2028-02-28", 1), "2028-02-29");
eq("shiftMonth: forward over a year", shiftMonth("2026-12", 1), "2027-01");
eq("shiftMonth: back over a year", shiftMonth("2027-01", -1), "2026-12");
eq("shiftMonth: twelve", shiftMonth("2026-09", 12), "2027-09");

const oct = monthRange("2026-10");
eq("month: bounds", [oct.from, oct.to], ["2026-10-01", "2026-11-01"]);
eq("month: 31 days", oct.days.length, 31);
eq("month: 1 Oct 2026 is a Thursday", oct.days[0].dow, 4);
eq("month: February in a leap year", monthRange("2028-02").days.length, 29);

// ---- bars ----
eq("bar: inside the month", bars([s("a", "2026-10-03", "2026-10-10")], oct.from, oct.to).map((b) =>
  [b.start, b.span, b.clippedStart, b.clippedEnd]), [[3, 7, false, false]]);

eq("bar: checkout on the 1st of next month fills to the end, unclipped",
  bars([s("a", "2026-10-25", "2026-11-01")], oct.from, oct.to).map((b) =>
    [b.start, b.span, b.clippedEnd]), [[25, 7, false]]);

eq("bar: started last month is clipped at the start",
  bars([s("a", "2026-09-28", "2026-10-04")], oct.from, oct.to).map((b) =>
    [b.start, b.span, b.clippedStart]), [[1, 3, true]]);

eq("bar: runs into next month is clipped at the end",
  bars([s("a", "2026-10-29", "2026-11-05")], oct.from, oct.to).map((b) =>
    [b.start, b.span, b.clippedEnd]), [[29, 3, true]]);

eq("bar: spans the whole month", bars([s("a", "2026-09-01", "2026-12-01")], oct.from, oct.to).map((b) =>
  [b.start, b.span, b.clippedStart, b.clippedEnd]), [[1, 31, true, true]]);

eq("bar: left on the 1st has no night in the month",
  bars([s("a", "2026-09-24", "2026-10-01")], oct.from, oct.to), []);

eq("bar: arrives on the 1st of next month is not shown",
  bars([s("a", "2026-11-01", "2026-11-08")], oct.from, oct.to), []);

// ---- upcoming ----
eq("upcoming: a turnover is one line", upcoming([
  s("les-hiboux", "2026-10-01", "2026-10-05"),
  s("les-hiboux", "2026-10-05", "2026-10-09"),
], "2026-10-01", 14), [
  { date: "2026-10-01", property: "les-hiboux", kind: "arrive" },
  { date: "2026-10-05", property: "les-hiboux", kind: "turnover" },
  { date: "2026-10-09", property: "les-hiboux", kind: "leave" },
]);

eq("upcoming: blocks are not arrivals", upcoming([
  s("the-farmhouse", "2026-10-03", "2026-10-31", "blocked"),
], "2026-10-01", 14), []);

eq("upcoming: a departure today is shown", upcoming([
  s("le-petit-renard", "2026-09-20", "2026-10-01"),
], "2026-10-01", 14), [{ date: "2026-10-01", property: "le-petit-renard", kind: "leave" }]);

eq("upcoming: the window end is exclusive", upcoming([
  s("le-petit-renard", "2026-10-15", "2026-10-20"),
], "2026-10-01", 14), []);

eq("upcoming: same day at two properties is two lines", upcoming([
  s("a", "2026-09-28", "2026-10-03"),
  s("b", "2026-10-03", "2026-10-06"),
], "2026-10-01", 14).map((e) => e.kind), ["leave", "arrive", "leave"]);

// ---- feed health ----
const now = Date.parse("2026-09-29T12:00:00Z");
eq("feed: fresh", feedHealth({ active: true, last_success_at: "2026-09-29T10:00:00Z", last_status: "ok" }, now), "ok");
eq("feed: not modified is fine", feedHealth({ active: true, last_success_at: "2026-09-29T09:17:00Z", last_status: "not_modified" }, now), "ok");
eq("feed: never synced", feedHealth({ active: true, last_success_at: null, last_status: null }, now), "never");
eq("feed: failing", feedHealth({ active: true, last_success_at: "2026-09-20T10:00:00Z", last_status: "http_404" }, now), "failing");
eq("feed: stale", feedHealth({ active: true, last_success_at: "2026-09-10T10:00:00Z", last_status: "ok" }, now), "stale");
eq("feed: a day and a half without a success is stale",
  feedHealth({ active: true, last_success_at: "2026-09-28T00:00:00Z", last_status: "ok" }, now), "stale");
eq("feed: twenty hours is fine",
  feedHealth({ active: true, last_success_at: "2026-09-28T16:00:00Z", last_status: "not_modified" }, now), "ok");
eq("feed: inactive", feedHealth({ active: false, last_success_at: null }, now), "inactive");

// ---- enquiries, holds and gaps ----
eq("hold: no expiry set", holdState(null, "2026-10-05"), "open");
eq("hold: lapsed yesterday", holdState("2026-10-04", "2026-10-05"), "lapsed");
eq("hold: the last day is not lapsed", holdState("2026-10-05", "2026-10-05"), "soon");
eq("hold: three days to go", holdState("2026-10-08", "2026-10-05"), "soon");
eq("hold: a week to go", holdState("2026-10-12", "2026-10-05"), "ok");
eq("response: answered after 5 hours", responseHours("2026-10-05T09:00:00Z", "2026-10-05T14:00:00Z", 0), 5);
eq("response: unanswered counts up to now", responseHours("2026-10-05T09:00:00Z", null, Date.parse("2026-10-06T09:00:00Z")), 24);
{
  const p = {
    enquiries: [{ status: "new" }, { status: "responded" }, { status: "lost" }],
    direct: [{ status: "tentative", hold_expires_on: "2026-10-01" }, { status: "confirmed", hold_expires_on: null }],
    gaps: [{ nights: 3 }],
  };
  eq("summary: everything waiting", pipelineSummary(p, "2026-10-05"),
    { text: "1 enquiry to answer · 1 waiting on the guest · 1 hold (1 lapsed) · 1 short gap", urgent: true });
  eq("summary: nothing waiting", pipelineSummary({ enquiries: [{ status: "lost" }], direct: [], gaps: [] }, "2026-10-05"),
    { text: "nothing waiting", urgent: false });
}

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) Deno.exit(1);

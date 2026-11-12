# EventReduce for the realtime updates of the list view

Measured on the ERPNext "Sales Invoice" list. One place is changed: the realtime refresh of
Frappe's list view (`frappe/public/js/frappe/list/list_view.js`), behind a System Setting that
is off by default.

## Result

On a real bench (Chromium, MariaDB, Redis, socketio), 1,500 seeded writes, list checked against
a SQL query after every write:

| "open, posting_date desc, 20 rows" | Wrong after event | Requests | Full list queries | DB queries | Rows sent | kB sent |
|---|---:|---:|---:|---:|---:|---:|
| develop today (flag off) | 1,466 (97.7 %) | 1,555 | 0 | 6,225 | 1,667 | 3,353 |
| EventReduce, buffer off | **0** | 2,026 | 223 | 8,117 | 6,253 | 5,282 |
| EventReduce + result window buffer | **0** | 1,587 | 10 | 6,347 | 2,065 | 3,518 |
| full refresh on every change | **0** | 3,051 | 1,432 | 12,203 | 30,360 | 12,656 |

- **Correctness:** the list of develop is wrong after almost every event. With EventReduce it
  was right after every event, on all three views.
- **Cost against "always full refresh"** (the simple way to be correct): with the buffer, 48 %
  fewer requests and DB queries, 93 % fewer rows, 72 % fewer bytes. On the 40-row list: 96 %
  fewer rows, 84 % fewer bytes.
- **Cost against develop:** about the same (2 % more requests), because develop already
  fetches the changed document by name. The gain against develop is correctness, not cost.
- **The buffer matters:** it cuts the full queries from 223 to 10 (85.1 % → 99.3 % of the events
  handled without one).
- **Not faster:** the time from save to a correct list is the same for all correct strategies
  (p50 ≈ 3.1–3.3 s). The 2-second debounce of the list view dominates it.
- **The benchmark found two races** in my first versions of the change. Both are fixed and
  have a test.

The full run of 2,000 events did not finish: the container was restarted twice during the
3-hour runs. The numbers above are the first 1,500 events of the last run with the final
code. A second run with the same code (1,400 events) agrees.

## What was changed

In Frappe (base `develop` 4c73618), one commit, 443 lines added, 6 removed:

| File | Change |
|---|---|
| `frappe/public/js/frappe/list/list_view.js` | realtime handler uses a result window when the setting is on |
| `frappe/public/js/frappe/list/list_result_window.js` | new: filters → selector, ChangeEvents, EventReduce + buffer |
| `system_settings.json` / `.py` | Check `event_reduce_list_updates`, default 0 |
| `package.json`, `yarn.lock` | `event-reduce-js@7.5.1` |

How it works with the setting on:

1. The server event `list_update` and the permission model are untouched.
2. The client fetches the changed documents by name through `frappe.desk.reportview.get`, with
   the filters of the list. This is the same permission-checked request develop sends.
3. Frappe filters are translated to a Mongo-style selector. A filter that cannot be translated
   (for example `Timespan`, child table filters, `or_filters`) switches the list to a full
   refresh on every change.
4. The change is applied with EventReduce and the result window buffer (4 rows for 20, 5 for
   40). A full refresh only happens on `runFullQueryAgain`.

The Frappe change is **not pushed**: there is no fork of frappe/frappe in the scope of this
session. It is delivered as
`frappe-patch/0001-feat-list-view-realtime-updates-with-EventReduce.patch` (apply with
`git am` on 4c73618).

## How it was measured

### Real bench (primary)

- Hand-built bench: frappe develop + erpnext develop, MariaDB, Redis, socketio, production
  build of the assets.
- 5,000 seeded Sales Invoices (`seed/invoices-5000-seed2026.json`), restored from a snapshot
  before every run.
- 15 Chromium pages on the same site: 3 views × 5 strategies. They all see the same writes.
- A second user sends the seeded writes through the REST API: new draft, edit, submit, pay,
  cancel, delete, move date. Share of writes aimed at visible rows: 0.4.
- After each write the driver waits until the lists settle, then compares the rows in the DOM
  (names and order, and the shown values for staleness) with a SQL query on MariaDB.
- Requests, rows and bytes are counted in the browser. DB queries and server time per request
  come from an instrumented web server (`bench/serve_instrumented.py`).

Views:

| View | Filter | Sort | Rows |
|---|---|---|---:|
| V1 | status in (Draft, Unpaid, Overdue) ("open") | posting_date desc, name | 20 |
| V2 | same | same | 40 (20 + Load More) |
| V3 | status in (Unpaid, Overdue) | modified desc, name | 20 |

Strategies:

- **default**: develop behaviour (flag off).
- **default + manual refresh**: as default, but the list is refreshed by hand after each
  check. It shows how often one event breaks a correct list. The manual refreshes are not
  counted as cost.
- **EventReduce, buffer 0** and **EventReduce + buffer**: the change.
- **full refresh on every change**: the comparison the task asked for.

### Harness (secondary, not the real thing)

A Node harness runs the merge code of `list_view.js`, extracted unmodified, against an
in-memory dataset. It has no browser, no network, no database and no timing. It is useful for
sweeps over seeds and parameters and it runs the full 2,000 events in seconds. It says nothing
about races or latency.

## Numbers

### Real bench, run 4: 1,500 events, final code, 161 min

Write through the REST API: p50 120 ms, p95 193 ms. Every list query costs 4 DB queries; a
full refresh sends a list query and a count query.

**V1: open, posting_date desc, 20 rows** (516 events change this list)

| Strategy | Wrong | Requests | Full queries | Without full query | DB queries | Rows | kB | Save → correct p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| default | 1,466 (97.7 %) | 1,555 | 0 | – | 6,225 | 1,667 | 3,353 | – |
| default + manual refresh | 1,039 (69.3 %) | 1,543 | 0 | – | 6,171 | 1,389 | 3,242 | – |
| EventReduce, buffer 0 | 0 | 2,026 | 223 | 85.1 % | 8,117 | 6,253 | 5,282 | 3.2 / 6.6 s |
| EventReduce + buffer | 0 | 1,587 | 10 | 99.3 % | 6,347 | 2,065 | 3,518 | 3.0 / 6.7 s |
| full refresh | 0 | 3,051 | 1,432 | 4.5 % | 12,203 | 30,360 | 12,656 | 3.3 / 6.8 s |

**V2: open, posting_date desc, 40 rows after Load More** (604 events change this list)

| Strategy | Wrong | Requests | Full queries | Without full query | DB queries | Rows | kB | Save → correct p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| default | 1,466 (97.7 %) | 1,553 | 0 | – | 6,211 | 2,306 | 3,554 | – |
| default + manual refresh | 1,042 (69.5 %) | 1,531 | 0 | – | 6,123 | 1,664 | 3,319 | – |
| EventReduce, buffer 0 | 0 | 2,019 | 218 | 85.5 % | 8,075 | 11,353 | 6,901 | 3.3 / 6.8 s |
| EventReduce + buffer | 0 | 1,569 | 2 | 99.9 % | 6,282 | 2,563 | 3,659 | 3.2 / 6.8 s |
| full refresh | 0 | 3,051 | 1,415 | 5.7 % | 12,203 | 60,720 | 22,335 | 3.4 / 6.9 s |

**V3: unpaid + overdue, modified desc, 20 rows** (559 events change this list)

| Strategy | Wrong | Requests | Full queries | Without full query | DB queries | Rows | kB | Save → correct p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| default | 1,351 (90.1 %) | 1,554 | 0 | – | 6,229 | 1,083 | 2,803 | – |
| default + manual refresh | 528 (35.2 %) | 1,548 | 0 | – | 6,191 | 903 | 2,727 | – |
| EventReduce, buffer 0 | 0 | 1,787 | 107 | 92.9 % | 7,154 | 3,286 | 3,739 | 3.3 / 6.7 s |
| EventReduce + buffer | 0 | 1,569 | 1 | 99.9 % | 6,282 | 1,262 | 2,880 | 3.2 / 6.7 s |
| full refresh | 0 | 3,046 | 1,425 | 5.0 % | 12,183 | 30,260 | 12,652 | 3.6 / 7.0 s |

Notes on the tables:

- "Full queries" excludes the 5-minute refresh that every list view runs anyway (32–40 per
  page in this run; 86–103 for the full-refresh pages, where they overlap with their own
  refreshes).
- "Requests" and the columns after it include everything the page sent, also those 5-minute
  refreshes.
- Why the default list is wrong: the merge of develop adds rows that now match and updates
  rows in place, but it never removes a row that is pushed out, and it does not fetch the row
  that moves up when one leaves. Most wrong states are an extra row or a wrong length. The
  5-minute refresh heals the list, until the next event.
- Save → correct is not given for the default strategies, because they rarely become correct.

Run 3 (same code, 1,400 events, 125 min) gave the same picture: 0 wrong for EventReduce and
full refresh on all views; V1 full queries 207 (buffer 0) and 8 (buffer); save → correct
p50 / p95 ≈ 3.0–3.3 / 5.1–5.2 s. The p95 of run 4 is higher for every strategy alike, so I
put that down to the machine, not to the code.

### Harness, 2,000 events, seed 2026 (not the real thing)

| View | Strategy | Wrong | Full queries | Without full query | Rows |
|---|---|---:|---:|---:|---:|
| V1 | default | 1,999 (100 %) | 0 | – | – |
| V1 | default + manual refresh | 1,401 (70.0 %) | 0 | – | – |
| V1 | EventReduce, buffer 0 | 0 | 298 | 85.1 % | 7,341 |
| V1 | EventReduce + buffer | 0 | 19 | 99.1 % | 1,837 |
| V1 | full refresh | 0 | 2,000 | 0 % | 40,000 |
| V2 | EventReduce, buffer 0 | 0 | 292 | 85.4 % | – |
| V2 | EventReduce + buffer | 0 | 7 | 99.7 % | – |
| V3 | EventReduce, buffer 0 | 0 | 123 | 93.9 % | – |
| V3 | EventReduce + buffer | 0 | 1 | 99.9 % | – |

Sweeps (seeds 1–3, visible share 0 / 0.2 / 0.8, bursts of 5 events in one debounce window):
EventReduce is never wrong; with the buffer it needs 0 to 35 full queries per 2,000 events.
The harness has no 5-minute refresh, so its default list never heals (100 % wrong against
97.7 % on the bench).

### Harness against bench

`bench/cross_check.js` compares both event by event. For run 3 the 1,400 writes were identical
in both and the EventReduce and full-refresh lists agreed on every event. Run 4 ran one
calendar day after the seed date, so only 1,028 of its 1,500 writes hit the same invoice as in
the harness; the EventReduce and full-refresh lists were still correct in both on every event.

## Two bugs the benchmark found

Both were in my change, both only show with real timing, and the harness could not see them.

1. **Stale full refresh** (run 1, 26 wrong states on V3 with buffer). A slow full refresh was
   answered by the server before a write was committed, but reached the browser after the
   by-name update of that write was applied. It overwrote the list. Fix: changes that arrive
   while a full refresh is on its way are applied again after it.
   Repro on a real bench: `bench/stale_refresh_check.js`.
2. **Dropped event** (run 2, 3 and 55+ wrong states on V2). `setup_realtime_updates()` runs
   after every refresh and empties the list of pending changes. An event that arrived between
   the rendering of the response and that call was lost. Fix: pending changes are kept when a
   result window is active. Check: `bench/refresh_timing_check.mjs` (16 of 16 timings correct
   after the fix, 1 wrong before).

Both have a unit test in `test/stale_refresh.test.js` that fails without its fix. The
partial results of runs 1 and 2 are kept in `results/` as evidence.

The merge code of develop looks open to the first race as well. I did not test that.

## Tests

| What | Result |
|---|---|
| `node --test "test/*.test.js"` (filter translation, edge cases, races) | 25 pass |
| Frappe pre-commit (prettier, eslint) on the changed files | pass |
| `test_system_settings`, `test_listview`, `test_boot` | 3, 9, 14 pass |
| `test_reportview` | 28 of 29; one email error, unrelated to the change |
| Frappe Playwright specs, flag off | 15 of 16 |
| Frappe Playwright specs, flag on | 32 of 33, the same single failure |

The Frappe Python and Playwright tests ran **before** the two race fixes and were not run
again after them. After the fixes I ran the Node tests, pre-commit and the two bench checks.

## Limitations and things not verified

- **No finished 2,000-event browser run.** The longest runs with the final code are 1,500 and
  1,400 events.
- **One machine, one site, one doctype.** All 15 pages share one CPU with the server, so the
  latency numbers are rough. The request and row counts do not depend on that.
- **No true paging.** Frappe's list has no skip; "Load More" raises the limit. The paged case
  is therefore the 40-row list. `test/skip_window.test.js` shows what a real skip would need;
  it is not in the patch.
- **Latency is not improved**, and cannot be while the 2-second debounce stays.
- **Against develop the cost is the same, not lower.** The saving only exists against a list
  that refreshes fully on every change.
- **The client-side matcher is close to redundant** in practice: the server already applies
  the filters to the by-name fetch. The selector is used as a gate (can this list be handled?)
  and as a guard.
- **Bundle size:** `list.bundle` grows by 12.6 kB minified, 4.6 kB gzipped.
- **Not tested:** group-by sidebar counts, other views (report, kanban, image), lists with
  child-table or `or` filters (they fall back to full refresh by design), several users with
  different permissions, slow or flaky networks, the single Playwright failure against a
  pristine develop.
- The DocType JSON of System Settings was edited by script, not through the UI.

## What an upstream PR to frappe/frappe would contain

Nothing was opened upstream. A PR would need:

1. An issue first. Frappe's contribution rules ask for agreement before a new setting.
2. The patch in `frappe-patch/` (6 files), rebased on current develop.
3. The unit tests, moved into Frappe's own JS test setup, and one Playwright spec for the
   list with the setting on.
4. The table of V1 from this report and a link to the benchmark.
5. Probably as a separate, smaller PR: the fix for the stale-refresh race in the existing
   merge path, if it is confirmed there.

## Reproduce

```bash
cd benchmarks/list_view_event_reduce
npm install
FRAPPE_PATH=~/frappe-bench/apps/frappe npm test
node harness/run.js --frappe ~/frappe-bench/apps/frappe --seed 2026 --events 2000 --out results/harness-seed2026.json
```

Real bench (needs a bench with frappe + erpnext, the patch applied, assets built):

```bash
# from ~/frappe-bench/sites: company, customers, item, then 5,000 invoices
../env/bin/python <this dir>/bench/setup_site.py bench.localhost
../env/bin/python <this dir>/bench/seed_invoices.py bench.localhost 5000 2026
# take a DB dump here; before each run: bench/restore_snapshot.sh <db name> <snapshot.sql.gz>
(cd ~/frappe-bench/sites && ../env/bin/python <this dir>/bench/serve_instrumented.py bench.localhost 8000) &
node ~/frappe-bench/apps/frappe/socketio.js &
node bench/driver.js --bench ~/frappe-bench --events 2000 --seed 2026 --out results/bench-seed2026.json
node bench/report.js results/bench-seed2026.json
node bench/cross_check.js results/harness-seed2026.json results/bench-seed2026.json
```

The header of each script has its exact options. A full run takes about 3.5 hours.

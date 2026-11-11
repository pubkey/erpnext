/**
 * A full refresh that the server answered before a write, but whose response arrives after
 * the realtime update of this write was applied (found by the browser benchmark, see
 * bench/stale_refresh_check.js for the same on a real bench).
 *
 * Runs the real list_view.js code of the working tree in the harness.
 *   FRAPPE_PATH=~/frappe-bench/apps/frappe node --test "test/*.test.js"
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { load_list_view } from "../harness/extract.js";
import { compare, ListRunner } from "../harness/list_runner.js";
import { MemorySite } from "../harness/memory_site.js";

const TODAY = "2026-11-11";
const VIEW = {
	filters: [["Sales Invoice", "status", "in", ["Unpaid", "Overdue"]]],
	sort_by: "posting_date",
	sort_order: "desc",
	page_length: 20,
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function create_site() {
	const invoices = Array.from({ length: 60 }, (_, index) => ({
		name: `ACC-SINV-2026-${String(index + 1).padStart(5, "0")}`,
		customer: "Customer",
		posting_date: `2026-${String(1 + (index % 9)).padStart(2, "0")}-${String(1 + (index % 28)).padStart(2, "0")}`,
		due_date: "2026-12-31",
		grand_total: 100,
		status: "Unpaid",
		docstatus: 1,
		modified: "2026-01-01 00:00:00.000000",
		po_no: null,
	}));
	return new MemorySite(invoices, TODAY);
}

async function run(git_ref) {
	const source = await load_list_view(process.env.FRAPPE_PATH, git_ref);
	const site = create_site();
	const runner = new ListRunner(source, site, VIEW, { event_reduce: true });
	await runner.open();

	// the server answers the next full query now, the response arrives later
	let release;
	const released = new Promise((resolve) => (release = resolve));
	const call = site.call.bind(site);
	let held = false;
	site.call = (call_args) => {
		const response = call(call_args);
		if (held || call_args.args.filters.some((filter) => filter[1] === "name")) return response;
		held = true;
		return response.then((r) => released.then(() => r));
	};
	runner.list.last_args = null;
	runner.list.refresh();
	for (let i = 0; i < 5; i++) await tick();
	assert.ok(held);

	const name = site.apply({
		kind: "new_submitted",
		customer: "Customer",
		posting_date: TODAY,
		due_date: "2026-12-31",
		qty: 1,
		rate: 100,
	});
	runner.notify(name);
	runner.list.process_document_refreshes();
	for (let i = 0; i < 5; i++) await tick();
	assert.equal(runner.list.data[0].name, name);

	release();
	await runner.idle();
	return compare(runner.list.data, runner.truth());
}

test("a change that arrives during a full refresh is applied again after it", async () => {
	assert.equal(await run(null), null);
});

/**
 * Unit tests for frappe/public/js/frappe/list/list_result_window.js.
 *   FRAPPE_PATH=~/frappe-bench/apps/frappe node --test test/
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { create_rng } from "../bench/workload.js";

const frappe_path = process.env.FRAPPE_PATH;
assert.ok(frappe_path, "set FRAPPE_PATH to the frappe checkout with the EventReduce branch");
const { get_mongo_selector, matches_selector, get_sort_comparator, ListResultWindow } = await import(
	pathToFileURL(join(frappe_path, "frappe/public/js/frappe/list/list_result_window.js"))
);

const DOCTYPE = "Sales Invoice";
const FIELDTYPES = {
	status: "Select",
	posting_date: "Date",
	grand_total: "Currency",
	customer: "Link",
	is_return: "Check",
	po_no: "Data",
};
const get_fieldtype = (fieldname) => FIELDTYPES[fieldname];
const selector = (...filters) =>
	get_mongo_selector(
		filters.map((filter) => [DOCTYPE, ...filter]),
		DOCTYPE,
		get_fieldtype
	);
const matches = (doc, ...filters) => matches_selector(doc, selector(...filters));

// ---------------------------------------------------------------------------
// filters -> Mongo-style selector
// ---------------------------------------------------------------------------

test("translates every supported operator", () => {
	assert.deepEqual(selector(["status", "=", "Unpaid"]), { $and: [{ status: { $eq: "Unpaid" } }] });
	assert.deepEqual(selector(["status", "!=", "Paid"]), { $and: [{ status: { $ne: "Paid" } }] });
	assert.deepEqual(selector(["grand_total", "<", "100"]), { $and: [{ grand_total: { $lt: 100 } }] });
	assert.deepEqual(selector(["grand_total", ">", 100]), { $and: [{ grand_total: { $gt: 100 } }] });
	assert.deepEqual(selector(["grand_total", "<=", 100]), { $and: [{ grand_total: { $lte: 100 } }] });
	assert.deepEqual(selector(["grand_total", ">=", 100]), { $and: [{ grand_total: { $gte: 100 } }] });
	assert.deepEqual(selector(["status", "in", ["Unpaid", "Overdue"]]), {
		$and: [{ status: { $in: ["Unpaid", "Overdue"] } }],
	});
	assert.deepEqual(selector(["status", "in", "Unpaid, Overdue"]), {
		$and: [{ status: { $in: ["Unpaid", "Overdue"] } }],
	});
	assert.deepEqual(selector(["status", "not in", ["Paid"]]), { $and: [{ status: { $nin: ["Paid"] } }] });
	assert.deepEqual(selector(["customer", "like", "%Bench%"]), {
		$and: [{ customer: { $regex: "^[\\s\\S]*Bench[\\s\\S]*$", $options: "i" } }],
	});
	assert.deepEqual(selector(["po_no", "is", "set"]), { $and: [{ po_no: { $nin: [null, ""] } }] });
	assert.deepEqual(selector(["po_no", "is", "not set"]), { $and: [{ po_no: { $in: [null, ""] } }] });
	assert.deepEqual(selector(["posting_date", "Between", ["2026-01-01", "2026-01-31"]]), {
		$and: [{ posting_date: { $gte: "2026-01-01", $lte: "2026-01-31" } }],
	});
	assert.deepEqual(selector(["modified", "between", ["2026-01-01", "2026-01-31"]]), {
		$and: [{ modified: { $gte: "2026-01-01 00:00:00.000000", $lte: "2026-01-31 23:59:59.999999" } }],
	});
	assert.deepEqual(selector(), { $and: [] });
	// several filters are combined with and
	assert.equal(selector(["status", "=", "Unpaid"], ["is_return", "=", 0]).$and.length, 2);
});

test("returns null for filters that it cannot translate", () => {
	// a filter on a child table
	assert.equal(
		get_mongo_selector([["Sales Invoice Item", "item_code", "=", "X"]], DOCTYPE, get_fieldtype),
		null
	);
	assert.equal(selector(["unknown_field", "=", "x"]), null);
	assert.equal(selector(["posting_date", "Timespan", "last month"]), null);
	assert.equal(selector(["customer", "descendants of", "X"]), null);
	assert.equal(selector(["customer", "not like", "%x%"]), null);
	assert.equal(selector(["status", "in", []]), null);
	assert.equal(selector(["status", "in", ["Unpaid", ""]]), null);
	assert.equal(selector(["grand_total", ">", "abc"]), null);
	assert.equal(selector(["grand_total", "like", "%1%"]), null);
	assert.equal(selector(["posting_date", "between", ["2026-01-01"]]), null);
	assert.equal(selector(["po_no", "is", "something"]), null);
	assert.equal(get_mongo_selector([["Sales Invoice", "status", "="]], DOCTYPE, get_fieldtype), null);
});

test("the selector matches like the list query", () => {
	const doc = { status: "Unpaid", grand_total: 150, customer: "Bench Customer 01", po_no: null, posting_date: "2026-03-05", is_return: 0 };
	assert.equal(matches(doc, ["status", "=", "Unpaid"]), true);
	assert.equal(matches(doc, ["status", "=", "Paid"]), false);
	assert.equal(matches(doc, ["status", "!=", "Paid"]), true);
	assert.equal(matches(doc, ["status", "in", ["Unpaid", "Overdue"]]), true);
	assert.equal(matches(doc, ["status", "not in", ["Unpaid", "Overdue"]]), false);
	assert.equal(matches(doc, ["grand_total", ">", "100"]), true);
	assert.equal(matches(doc, ["grand_total", "<", 150]), false);
	assert.equal(matches(doc, ["grand_total", "<=", 150]), true);
	assert.equal(matches(doc, ["grand_total", ">=", 151]), false);
	assert.equal(matches(doc, ["is_return", "=", "0"]), true);
	assert.equal(matches(doc, ["customer", "like", "%customer 0_"]), true);
	assert.equal(matches(doc, ["customer", "like", "customer%"]), false);
	assert.equal(matches(doc, ["customer", "like", "%(x)%"]), false);
	assert.equal(matches(doc, ["po_no", "is", "not set"]), true);
	assert.equal(matches(doc, ["po_no", "is", "set"]), false);
	assert.equal(matches(doc, ["po_no", "=", ""]), true);
	assert.equal(matches(doc, ["po_no", "!=", "PO-1"]), true);
	assert.equal(matches(doc, ["po_no", "like", "%PO%"]), false);
	assert.equal(matches(doc, ["posting_date", "between", ["2026-03-01", "2026-03-05"]]), true);
	assert.equal(matches(doc, ["posting_date", "between", ["2026-03-06", "2026-03-31"]]), false);
	assert.equal(matches(doc, ["status", "=", "Unpaid"], ["grand_total", ">", 200]), false);
	assert.equal(
		matches({ modified: "2026-03-05 17:30:00.000000" }, ["modified", "between", ["2026-03-01", "2026-03-05"]]),
		true
	);
});

// ---------------------------------------------------------------------------
// sort
// ---------------------------------------------------------------------------

test("sorts by the sort field, ties by name in the same direction", () => {
	const rows = [
		{ name: "INV-3", posting_date: "2026-01-02" },
		{ name: "INV-1", posting_date: "2026-01-02" },
		{ name: "INV-2", posting_date: "2026-01-03" },
		{ name: "INV-4", posting_date: null },
	];
	const names = (sort_order) =>
		[...rows].sort(get_sort_comparator("posting_date", sort_order, "Date")).map((row) => row.name);
	// like MariaDB: null is the lowest value
	assert.deepEqual(names("desc"), ["INV-2", "INV-3", "INV-1", "INV-4"]);
	assert.deepEqual(names("asc"), ["INV-4", "INV-1", "INV-3", "INV-2"]);

	const by_total = get_sort_comparator("grand_total", "asc", "Currency");
	assert.equal(by_total({ name: "a", grand_total: 9 }, { name: "b", grand_total: 10 }), -1);
	assert.equal(by_total({ name: "b", grand_total: 10 }, { name: "a", grand_total: 10 }), 1);
	// name without case, like the collation of the database
	const by_name = get_sort_comparator("name", "asc");
	assert.equal(by_name({ name: "a-2" }, { name: "A-10" }), 1);
	assert.equal(by_name({ name: "A-1" }, { name: "a-2" }), -1);
	// the order of text depends on the collation of the database
	assert.equal(get_sort_comparator("customer", "asc", "Link"), null);
	assert.equal(get_sort_comparator("unknown", "asc", undefined), null);
});

// ---------------------------------------------------------------------------
// the result window
// ---------------------------------------------------------------------------

const OPEN = ["Draft", "Unpaid", "Overdue"];

class Table {
	constructor(count) {
		this.docs = new Map();
		for (let i = 1; i <= count; i++) {
			this.set(`INV-${String(i).padStart(4, "0")}`, "Unpaid", `2026-01-${String(1 + (i % 28)).padStart(2, "0")}`);
		}
	}
	set(name, status, posting_date) {
		this.docs.set(name, { name, status, posting_date });
	}
	// the list query: status in OPEN, order by posting_date desc, name desc
	query(limit) {
		return [...this.docs.values()]
			.filter((doc) => OPEN.includes(doc.status))
			.sort((a, b) =>
				a.posting_date !== b.posting_date
					? a.posting_date < b.posting_date ? 1 : -1
					: a.name < b.name ? 1 : -1
			)
			.slice(0, limit)
			.map((doc) => ({ ...doc }));
	}
	// the query for the changed names: only documents that match and can be read
	fetch(names) {
		return names
			.map((name) => this.docs.get(name))
			.filter((doc) => doc && OPEN.includes(doc.status) && !doc.unreadable)
			.map((doc) => ({ ...doc }));
	}
}

function create_window(table, limit, buffer_size) {
	const result_window = ListResultWindow.create({
		doctype: DOCTYPE,
		filters: [[DOCTYPE, "status", "in", OPEN]],
		sort_by: "posting_date",
		sort_order: "desc",
		limit,
		buffer_size,
		get_fieldtype,
	});
	assert.equal(result_window.reset(table.query(result_window.page_length)), true);
	return result_window;
}

const names_of = (rows) => rows.map((row) => row.name);

test("a row leaves a full page: the next row comes from the buffer", () => {
	const table = new Table(100);
	const result_window = create_window(table, 20, 4);
	assert.equal(result_window.page_length, 24);
	const first = result_window.results[0].name;

	table.set(first, "Paid", "2026-01-28");
	const result = result_window.apply([first], table.fetch([first]));
	assert.equal(result.run_full_query, false);
	assert.equal(result.changed, true);
	assert.equal(result.results.length, 20);
	assert.deepEqual(names_of(result.results), names_of(table.query(20)));
});

test("a row leaves a full page without buffer: the query runs again", () => {
	const table = new Table(100);
	const result_window = create_window(table, 20, 0);
	const first = result_window.results[0].name;
	table.set(first, "Paid", "2026-01-28");
	assert.deepEqual(result_window.apply([first], table.fetch([first])), { run_full_query: true });
	// and after the query the list is right again
	assert.equal(result_window.reset(table.query(result_window.page_length)), true);
	assert.deepEqual(names_of(result_window.results), names_of(table.query(20)));
});

test("the buffer is used up after more rows left than it holds", () => {
	const table = new Table(100);
	const result_window = create_window(table, 20, 4);
	let full_queries = 0;
	for (let i = 0; i < 5; i++) {
		const first = table.query(1)[0].name;
		table.docs.delete(first);
		if (result_window.apply([first], table.fetch([first])).run_full_query) full_queries++;
	}
	assert.equal(full_queries, 1);
});

test("a short list is complete: rows leave and enter without a query", () => {
	const table = new Table(5);
	const result_window = create_window(table, 20, 0);
	table.docs.delete("INV-0003");
	table.set("INV-0900", "Draft", "2025-01-01");
	const result = result_window.apply(["INV-0003", "INV-0900"], table.fetch(["INV-0003", "INV-0900"]));
	assert.equal(result.run_full_query, false);
	assert.deepEqual(names_of(result.results), names_of(table.query(20)));
	assert.equal(result.results.at(-1).name, "INV-0900");
});

test("an insert at the top of a list after Load More keeps 40 rows", () => {
	// A list view has no skip: after "Load More" it shows the rows 0 to 40.
	const table = new Table(100);
	const result_window = create_window(table, 40, 5);
	table.set("INV-0999", "Draft", "2026-12-31");
	const result = result_window.apply(["INV-0999"], table.fetch(["INV-0999"]));
	assert.equal(result.run_full_query, false);
	assert.equal(result.results.length, 40);
	assert.equal(result.results[0].name, "INV-0999");
	assert.deepEqual(names_of(result.results), names_of(table.query(40)));
});

test("ties on the sort field are ordered by name", () => {
	const table = new Table(0);
	for (const name of ["INV-0002", "INV-0004", "INV-0001"]) table.set(name, "Unpaid", "2026-01-01");
	const result_window = create_window(table, 20, 4);
	table.set("INV-0003", "Draft", "2026-01-01");
	const result = result_window.apply(["INV-0003"], table.fetch(["INV-0003"]));
	assert.deepEqual(names_of(result.results), ["INV-0004", "INV-0003", "INV-0002", "INV-0001"]);
});

test("a cancelled document leaves the list", () => {
	const table = new Table(100);
	const result_window = create_window(table, 20, 4);
	const shown = result_window.results[7].name;
	table.set(shown, "Cancelled", table.docs.get(shown).posting_date);
	const result = result_window.apply([shown], table.fetch([shown]));
	assert.equal(result.run_full_query, false);
	assert.equal(names_of(result.results).includes(shown), false);
	assert.deepEqual(names_of(result.results), names_of(table.query(20)));

	// a cancelled document that was not in the list changes nothing
	const hidden = table.query(100).at(-1).name;
	table.set(hidden, "Cancelled", "2026-01-01");
	assert.deepEqual(result_window.apply([hidden], table.fetch([hidden])), {
		run_full_query: false,
		changed: false,
		results: result_window.results,
	});
});

test("a changed row that stays in the list is replaced or moved", () => {
	const table = new Table(100);
	const result_window = create_window(table, 20, 4);
	const [first, second] = names_of(result_window.results);
	table.set(second, "Draft", "2026-12-01");
	const result = result_window.apply([second], table.fetch([second]));
	assert.equal(result.run_full_query, false);
	assert.deepEqual(names_of(result.results).slice(0, 2), [second, first]);
	assert.equal(result.results[0].status, "Draft");
});

test("permissions: a document that the user cannot read anymore is removed", () => {
	const table = new Table(100);
	const result_window = create_window(table, 20, 4);
	const shown = result_window.results[3].name;
	// the permission-checked query does not return it
	table.docs.get(shown).unreadable = true;
	const result = result_window.apply([shown], table.fetch([shown]));
	assert.equal(result.run_full_query, false);
	assert.equal(names_of(result.results).includes(shown), false);
	assert.equal(result.results.length, 20);
});

test("fallback: no result window for filters or sort fields that cannot be translated", () => {
	const create = (overrides) =>
		ListResultWindow.create({
			doctype: DOCTYPE,
			filters: [[DOCTYPE, "status", "in", OPEN]],
			sort_by: "posting_date",
			sort_order: "desc",
			limit: 20,
			get_fieldtype,
			...overrides,
		});
	assert.ok(create({}));
	assert.equal(create({ filters: [["Sales Invoice Item", "item_code", "=", "X"]] }), null);
	assert.equal(create({ filters: [[DOCTYPE, "posting_date", "Timespan", "last week"]] }), null);
	assert.equal(create({ sort_by: "customer" }), null);
});

test("fallback: rows that do not fit the selector or the sort order are not loaded", () => {
	const table = new Table(30);
	const result_window = create_window(table, 20, 4);
	const rows = table.query(24);
	// the filter field is not part of the list query
	assert.equal(result_window.reset(rows.map(({ status, ...row }) => row)), false);
	assert.deepEqual(result_window.apply(["INV-0001"], []), { run_full_query: true });
	// the database sorts differently
	assert.equal(result_window.reset([...rows].reverse()), false);
	// the database filters differently
	assert.equal(result_window.reset([{ ...rows[0], status: "unpaid" }, ...rows.slice(1)]), false);
	assert.equal(result_window.reset(rows), true);
});

test("fallback: a returned row that the selector does not match runs the query again", () => {
	const table = new Table(30);
	const result_window = create_window(table, 20, 4);
	const result = result_window.apply(["INV-0001"], [{ name: "INV-0001", status: "UNPAID", posting_date: "2026-01-02" }]);
	assert.deepEqual(result, { run_full_query: true });
});

test("a change that did not reach the window runs the query again", () => {
	const table = new Table(30);
	const result_window = create_window(table, 20, 4);
	result_window.invalidate();
	assert.deepEqual(result_window.apply(["INV-0001"], table.fetch(["INV-0001"])), { run_full_query: true });
	result_window.reset(table.query(24));
	assert.equal(result_window.apply(["INV-0001"], table.fetch(["INV-0001"])).run_full_query, false);
});

for (const buffer_size of [0, 4, 20]) {
	test(`random writes give the rows of the query, buffer ${buffer_size}`, () => {
		const rng = create_rng(7 + buffer_size);
		const table = new Table(120);
		const result_window = create_window(table, 20, buffer_size);
		const statuses = ["Draft", "Unpaid", "Overdue", "Paid", "Cancelled"];
		let full_queries = 0;
		for (let i = 0; i < 3000; i++) {
			// 1 to 3 changed documents per update, like several writes within the debounce
			const names = [];
			for (let j = rng.int(1, 3); j > 0; j--) {
				const name = `INV-${String(rng.int(1, 160)).padStart(4, "0")}`;
				names.push(name);
				if (rng.next() < 0.15) {
					table.docs.delete(name);
				} else {
					table.set(name, rng.pick(statuses), `2026-01-${String(rng.int(1, 28)).padStart(2, "0")}`);
				}
			}
			const result = result_window.apply(names, table.fetch(names));
			if (result.run_full_query) {
				full_queries++;
				assert.equal(result_window.reset(table.query(result_window.page_length)), true);
			}
			assert.deepEqual(result_window.results, table.query(20), `after update ${i}`);
		}
		assert.ok(full_queries < 3000);
	});
}

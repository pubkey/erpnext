/**
 * A real skip window (skip 20 + limit 20) and change events without the previous state.
 *
 * The list view never has a skip: "Load More" adds rows to the same list. So this is not
 * code of the change. It tests event-reduce-js directly, to show what a paged list would
 * need: Frappe's realtime event only has the name of the changed document, so for a row
 * that is not in the buffer the previous state is unknown.
 *   FRAPPE_PATH=~/frappe-bench/apps/frappe node --test test/
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { create_rng } from "../bench/workload.js";

const require = createRequire(join(process.env.FRAPPE_PATH, "package.json"));
const {
	applyChangeEventsToResultWindowBuffer,
	createResultWindowBuffer,
	getResultWindowBufferQuery,
	getResultWindowBufferResults,
	resetResultWindowBuffer,
} = require("event-reduce-js");

const SKIP = 20;
const LIMIT = 20;
const compare = (a, b) => (a.value !== b.value ? (a.value < b.value ? -1 : 1) : a.id < b.id ? -1 : 1);
const query_params = {
	primaryKey: "id",
	sortFields: ["value", "id"],
	skip: SKIP,
	limit: LIMIT,
	queryMatcher: (doc) => doc.matches,
	sortComparator: compare,
};

/**
 * @param skip_buffer_size rows to keep before the window
 * @param with_previous true: the change event has the real previous state (like a database
 *     change stream); false: only the row of the buffer is known (like the list view)
 * @returns how often the result was wrong and how often the query ran again
 */
function run(skip_buffer_size, with_previous) {
	const rng = create_rng(42);
	const docs = new Map();
	for (let i = 0; i < 300; i++) {
		docs.set(`doc-${i}`, { id: `doc-${i}`, value: rng.int(0, 999), matches: rng.next() < 0.7 });
	}
	const query = (skip, limit) =>
		[...docs.values()]
			.filter((doc) => doc.matches)
			.sort(compare)
			.slice(skip, limit === undefined ? undefined : skip + limit);
	const buffer = createResultWindowBuffer(query_params, {
		limitBufferSize: 4,
		skipBufferSize: skip_buffer_size,
	});
	const load = () => {
		const { skip, limit } = getResultWindowBufferQuery(buffer, { skip: SKIP, limit: LIMIT });
		resetResultWindowBuffer(buffer, query(skip, limit));
	};
	load();

	let wrong = 0;
	let full_queries = 0;
	for (let i = 0; i < 3000; i++) {
		const id = `doc-${rng.int(0, 320)}`;
		const before = docs.get(id) || null;
		let doc = null;
		if (rng.next() < 0.85) {
			doc = { id, value: rng.int(0, 999), matches: rng.next() < 0.7 };
			docs.set(id, doc);
		} else {
			docs.delete(id);
		}
		if (!before && !doc) continue;

		// like the list view: the row comes back only if it matches, and the previous state
		// is the row of the buffer
		const known_doc = with_previous ? doc : doc?.matches ? doc : null;
		const previous = with_previous ? before : buffer.keyDocumentMap.get(id) || null;
		const events = [];
		if (known_doc || previous) {
			const operation = !previous ? "INSERT" : known_doc ? "UPDATE" : "DELETE";
			events.push({ operation, id, doc: known_doc, previous });
		}
		const result = applyChangeEventsToResultWindowBuffer(buffer, events);
		if (result.runFullQueryAgain) {
			full_queries++;
			load();
		}
		const shown = getResultWindowBufferResults(buffer).map((row) => row.id).join();
		if (shown !== query(SKIP, LIMIT).map((row) => row.id).join()) {
			wrong++;
			load();
		}
	}
	return { wrong, full_queries };
}

test("with the real previous state, a small buffer before the window is exact", () => {
	const result = run(4, true);
	assert.equal(result.wrong, 0);
	console.log("skip buffer 4, previous state known:", result);
});

test("without the previous state, a buffer that holds all skipped rows is exact", () => {
	// offset is 0: a row that is not in the buffer did not match or sorted after it
	const result = run(SKIP, false);
	assert.equal(result.wrong, 0);
	console.log("skip buffer 20 (all skipped rows), previous state unknown:", result);
});

test("without the previous state, a smaller buffer before the window gives wrong results", () => {
	// a row before the buffer can change or leave without the buffer noticing
	const result = run(4, false);
	assert.ok(result.wrong > 0);
	console.log("skip buffer 4, previous state unknown:", result);
});

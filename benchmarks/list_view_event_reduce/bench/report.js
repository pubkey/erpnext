#!/usr/bin/env node
/**
 * Prints the tables of a result file of bench/driver.js as markdown.
 *   node bench/report.js results/bench.json
 */
import { readFileSync } from "node:fs";

const result = JSON.parse(readFileSync(process.argv[2], "utf8"));
const LIST_QUERY = "frappe.desk.reportview.get";

const percentile = (values, p) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const percent = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)} %` : "-");
const number = (value) => Math.round(value).toLocaleString("en-US");

const kinds = {};
for (const operation of result.operations) {
	const kind = operation.failed ? `${operation.kind} (failed)` : operation.kind;
	kinds[kind] = (kinds[kind] || 0) + 1;
}
const write_ms = result.operations.filter((o) => !o.failed).map((o) => o.write_ms);
console.log(
	`${result.kind}: ${result.operations.length} events, seed ${result.seed}, visible share ${result.visible_share}, ` +
		`${Math.round(result.duration_s / 60)} min${result.finished ? "" : " (NOT FINISHED)"}`
);
console.log(`writes: ${JSON.stringify(kinds)}`);
console.log(`time of a write (REST API): p50 ${percentile(write_ms, 50)} ms, p95 ${percentile(write_ms, 95)} ms\n`);

const views = [...new Set(result.lists.map((list) => list.view))];
for (const view of views) {
	const lists = result.lists.filter((list) => list.view === view);
	const events = lists[0].events.filter(Boolean);
	console.log(`### ${view}\n`);
	console.log(`${events.filter((event) => event.changed).length} of ${events.length} events change the rows or the order of this list.\n`);
	console.log("| Strategy | Wrong after event | Share | length / missing / extra / order / stale | Requests | of them full list queries (without 5-minute refreshes) | Events without full query | DB queries | Rows | kB | Server time | Save to correct list p50 / p95 | Corrected | 5-minute refreshes |");
	console.log("|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
	for (const list of lists) {
		const checked = list.events.filter(Boolean);
		const wrong = checked.filter((event) => event.problems.length);
		const count = (problem) => checked.filter((event) => event.problems.includes(problem)).length;
		const requests = list.requests.slice(list.requests_to_open).filter((request) => !request.manual);
		// without the refresh that every list does every 5 minutes
		const is_full = (request) => request.method === LIST_QUERY && !request.by_name && !request.timer;
		const timer_refreshes = requests.filter(
			(request) => request.method === LIST_QUERY && !request.by_name && request.timer
		).length;

		// requests of each event: from the count after the previous event to the count after this one
		let without_full = 0;
		let previous = list.requests_to_open;
		for (const event of list.events) {
			if (!event) continue;
			const slice = list.requests.slice(previous, event.requests).filter((request) => !request.manual);
			if (!slice.some(is_full)) without_full++;
			previous = event.requests;
		}

		const changed = checked.filter((event) => event.changed);
		const corrected = changed.filter((event) => event.correct_ms !== null).map((event) => event.correct_ms);
		const sum = (get) => requests.reduce((total, request) => total + (get(request) || 0), 0);
		console.log(
			`| ${list.strategy} | ${wrong.length} | ${percent(wrong.length, checked.length)} | ` +
				`${count("length")} / ${count("missing")} / ${count("extra")} / ${count("order")} / ${count("stale")} | ` +
				`${number(requests.length)} | ${number(requests.filter(is_full).length)} | ${percent(without_full, checked.length)} | ` +
				`${number(sum((r) => r.db_queries))} | ${number(sum((r) => r.rows))} | ` +
				`${number(sum((r) => r.request_bytes + r.response_bytes) / 1024)} | ${number(sum((r) => r.server_ms) / 1000)} s | ` +
				`${corrected.length ? `${percentile(corrected, 50)} / ${percentile(corrected, 95)} ms` : "-"} | ` +
				`${corrected.length} of ${changed.length} | ${timer_refreshes} |`
		);
	}
	const methods = {};
	for (const list of lists) {
		for (const request of list.requests.slice(list.requests_to_open)) {
			if (request.manual) continue;
			const key = request.method === LIST_QUERY ? `${LIST_QUERY}${request.by_name ? " (changed names)" : " (full list)"}` : request.method;
			const entry = ((methods[key] ||= {})[list.strategy] ||= { count: 0, db: 0 });
			entry.count++;
			entry.db += request.db_queries || 0;
		}
	}
	console.log("\nRequests by method (count, DB queries per request):\n");
	for (const [method, by_strategy] of Object.entries(methods)) {
		const parts = Object.entries(by_strategy).map(
			([strategy, entry]) => `${strategy}: ${entry.count} × ${(entry.db / entry.count).toFixed(1)}`
		);
		console.log(`- \`${method}\`: ${parts.join("; ")}`);
	}
	console.log("");
}

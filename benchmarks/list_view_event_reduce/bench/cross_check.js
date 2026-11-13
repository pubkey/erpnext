#!/usr/bin/env node
/**
 * Compares a run of the harness with a run on the real bench, event by event:
 * the same writes on the same invoices, and the same events where a list was wrong.
 *   node bench/cross_check.js results/harness-seed2026.json results/bench-seed2026.json
 */
import { readFileSync } from "node:fs";

const harness = JSON.parse(readFileSync(process.argv[2], "utf8"));
const bench = JSON.parse(readFileSync(process.argv[3], "utf8"));
const STRATEGIES = {
	"default (develop)": "default (develop behaviour, flag off)",
	"default + manual refresh after every event": "default + manual refresh after every event",
	"EventReduce, buffer 0": "EventReduce, buffer 0",
	"EventReduce + buffer (recommended size)": "EventReduce + buffer (recommended size)",
	"full refresh on every change": "full refresh on every change",
};

const count = Math.min(harness.operations.length, bench.operations.length);
let same_writes = 0;
for (let i = 0; i < count; i++) {
	const a = harness.operations[i];
	const b = bench.operations[i];
	if (a.kind === b.kind && a.name === b.name) same_writes++;
}
console.log(`writes: ${same_writes} of ${count} are the same operation on the same invoice\n`);
console.log("| View | Strategy | Wrong in harness | Wrong on bench | Events where both agree | Full queries harness / bench |");
console.log("|---|---|---:|---:|---:|---:|");
for (const result of harness.results) {
	const list = bench.lists.find(
		(list) => list.view === result.view && list.strategy === STRATEGIES[result.strategy]
	);
	if (!list) continue;
	const wrong_in_harness = new Set(result.wrong_events.filter((event) => event <= count));
	let agree = 0;
	let wrong_on_bench = 0;
	for (let i = 0; i < count; i++) {
		const wrong = !!list.events[i]?.problems.length;
		if (wrong) wrong_on_bench++;
		if (wrong === wrong_in_harness.has(i + 1)) agree++;
	}
	const full = list.requests
		.slice(list.requests_to_open)
		.filter((r) => !r.manual && !r.timer && r.method === "frappe.desk.reportview.get" && !r.by_name).length;
	console.log(
		`| ${result.view} | ${result.strategy} | ${wrong_in_harness.size} | ${wrong_on_bench} | ${agree} of ${count} | ${result.full_queries} / ${full} |`
	);
}

#!/usr/bin/env node
/**
 * Standalone harness: replays the seeded workload against list views that run the real
 * realtime update code of Frappe's list_view.js, extracted from a frappe checkout.
 * The site is an in-memory model (memory_site.js), NOT a real bench. See bench/ for that.
 *
 *   node harness/run.js --frappe ~/frappe-bench/apps/frappe [--baseline-ref origin/develop]
 *       [--seed 2026] [--events 2000] [--visible-share 0.4] [--burst 1] [--out results/x.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { create_rng, next_operation } from "../bench/workload.js";
import { load_list_view } from "./extract.js";
import { MemorySite } from "./memory_site.js";
import { ListRunner, compare } from "./list_runner.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: options } = parseArgs({
	options: {
		frappe: { type: "string" },
		"baseline-ref": { type: "string", default: "origin/develop" },
		data: { type: "string", default: join(root, "seed/invoices-5000-seed2026.json") },
		seed: { type: "string", default: "2026" },
		events: { type: "string", default: "2000" },
		"visible-share": { type: "string", default: "0.4" },
		burst: { type: "string", default: "1" },
		out: { type: "string" },
		quiet: { type: "boolean", default: false },
	},
});
if (!options.frappe) {
	console.error("--frappe <path of the frappe checkout with the EventReduce branch> is required");
	process.exit(1);
}

const DOCTYPE = "Sales Invoice";
export const VIEWS = {
	"open, posting_date desc, 20 rows": {
		filters: [[DOCTYPE, "status", "in", ["Draft", "Unpaid", "Overdue"]]],
		sort_by: "posting_date",
		sort_order: "desc",
		page_length: 20,
	},
	"open, posting_date desc, 20 + Load More (40 rows)": {
		filters: [[DOCTYPE, "status", "in", ["Draft", "Unpaid", "Overdue"]]],
		sort_by: "posting_date",
		sort_order: "desc",
		page_length: 20,
		load_more: true,
	},
	"unpaid + overdue, modified desc, 20 rows": {
		filters: [[DOCTYPE, "status", "in", ["Unpaid", "Overdue"]]],
		sort_by: "modified",
		sort_order: "desc",
		page_length: 20,
	},
};
// the writes of the workload aim at the first page of this view
const WORKLOAD_VIEW = VIEWS["open, posting_date desc, 20 rows"];

const dataset = JSON.parse(readFileSync(options.data, "utf8"));
const baseline = await load_list_view(options.frappe, options["baseline-ref"]);
const branch = await load_list_view(options.frappe, null);
if (baseline.has_event_reduce || !branch.has_event_reduce) {
	console.error("expected the baseline ref without and the working tree with EventReduce");
	process.exit(1);
}

const STRATEGIES = {
	"default (develop)": { source: baseline },
	"default + manual refresh after every event": { source: baseline, manual_refresh: true },
	"branch, flag off": { source: branch },
	"EventReduce, buffer 0": { source: branch, event_reduce: true, buffer_size: 0 },
	"EventReduce + buffer (recommended size)": { source: branch, event_reduce: true },
	"EventReduce + buffer 20": { source: branch, event_reduce: true, buffer_size: 20 },
	"full refresh on every change": { source: baseline, full_refresh: true },
};

const events = Number(options.events);
const burst = Number(options.burst);
const visible_share = Number(options["visible-share"]);
const site = new MemorySite(dataset.invoices, dataset.today);
const rng = create_rng(Number(options.seed));

const runners = [];
for (const [view_name, view] of Object.entries(VIEWS)) {
	for (const [strategy_name, strategy] of Object.entries(STRATEGIES)) {
		const runner = new ListRunner(strategy.source, site, view, strategy);
		await runner.open();
		if (compare(runner.list.data, runner.truth())) {
			throw new Error(`${view_name} / ${strategy_name}: wrong before the first event`);
		}
		runners.push({
			view_name,
			strategy_name,
			runner,
			checks: 0,
			wrong: 0,
			problems: { length: 0, missing: 0, extra: 0, order: 0, stale: 0 },
			first_wrong: null,
			wrong_events: [],
			without_full_query: 0,
		});
	}
}

const operation_counts = {};
const operations = [];
let truth_changes = 0;
let previous_truth = JSON.stringify(runners[0].runner.truth());
for (let index = 0; index < events; index++) {
	const state = site.workload_state(WORKLOAD_VIEW.filters, "`t`.`posting_date` desc, `t`.`name` desc", 20);
	const operation = next_operation(rng, state, visible_share);
	operation_counts[operation.kind] = (operation_counts[operation.kind] || 0) + 1;
	const name = site.apply(operation);
	operations.push({ kind: operation.kind, name });
	for (const entry of runners) entry.runner.notify(name);
	if ((index + 1) % burst) continue;

	const truth = JSON.stringify(runners[0].runner.truth());
	if (truth !== previous_truth) truth_changes++;
	previous_truth = truth;

	for (const entry of runners) {
		const full_before = entry.runner.requests.filter((request) => request.full).length;
		await entry.runner.flush();
		const full_after = entry.runner.requests.filter((request) => request.full).length;
		if (full_after === full_before) entry.without_full_query++;
		entry.checks++;
		const problems = compare(entry.runner.list.data, entry.runner.truth());
		if (problems) {
			entry.wrong++;
			entry.first_wrong ??= index + 1;
			entry.wrong_events.push(index + 1);
			for (const problem of problems) entry.problems[problem]++;
		}
		if (entry.runner.options.manual_refresh) {
			// the user presses the refresh button; these requests are not counted
			const counted = entry.runner.requests.length;
			entry.runner.list.last_args = null;
			await entry.runner.list.refresh();
			await entry.runner.idle();
			entry.runner.requests.length = counted;
		}
	}
}

const results = runners.map((entry) => {
	const requests = entry.runner.requests.slice(entry.runner.requests_to_open);
	return {
		view: entry.view_name,
		strategy: entry.strategy_name,
		checks: entry.checks,
		wrong: entry.wrong,
		wrong_share: entry.wrong / entry.checks,
		problems: entry.problems,
		first_wrong: entry.first_wrong,
		requests: requests.length,
		full_queries: requests.filter((request) => request.full).length,
		without_full_query_share: entry.without_full_query / entry.checks,
		rows: requests.reduce((sum, request) => sum + request.rows, 0),
		bytes: requests.reduce((sum, request) => sum + request.bytes, 0),
		wrong_events: entry.wrong_events,
	};
});

const percent = (share) => `${(share * 100).toFixed(1)} %`;
if (!options.quiet) {
	console.log(
		`harness (in-memory site, real list_view.js code): ${dataset.invoices.length} invoices, ` +
			`${events} events, seed ${options.seed}, visible share ${visible_share}, burst ${burst}`
	);
	console.log("operations:", JSON.stringify(operation_counts));
	console.log(`events that change the first page of the workload view: ${truth_changes}`);
	for (const view_name of Object.keys(VIEWS)) {
		console.log(`\n## ${view_name}\n`);
		console.log("| Strategy | Wrong after event | Share | length / missing / extra / order / stale | Requests | Full queries | Without full query | Rows | kB |");
		console.log("|---|---:|---:|---|---:|---:|---:|---:|---:|");
		for (const r of results.filter((result) => result.view === view_name)) {
			const p = r.problems;
			console.log(
				`| ${r.strategy} | ${r.wrong} | ${percent(r.wrong_share)} | ${p.length} / ${p.missing} / ${p.extra} / ${p.order} / ${p.stale} | ` +
					`${r.requests} | ${r.full_queries} | ${percent(r.without_full_query_share)} | ${r.rows} | ${Math.round(r.bytes / 1024)} |`
			);
		}
	}
}
if (options.out) {
	writeFileSync(
		options.out,
		JSON.stringify(
			{
				kind: "harness (in-memory site)",
				invoices: dataset.invoices.length,
				events,
				seed: Number(options.seed),
				visible_share,
				burst,
				operation_counts,
				truth_changes,
				results,
				operations,
			},
			null,
			1
		)
	);
}

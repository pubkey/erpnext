#!/usr/bin/env node
/**
 * One table over several result files of harness/run.js, for one view.
 *   node harness/summary.js "open, posting_date desc, 20 rows" results/harness-*.json
 */
import { readFileSync } from "node:fs";

const [view, ...files] = process.argv.slice(2);
console.log("| Run | Strategy | Wrong after event | Share | Full queries | Events without full query | Rows |");
console.log("|---|---|---:|---:|---:|---:|---:|");
for (const file of files) {
	const run = JSON.parse(readFileSync(file, "utf8"));
	const label = `seed ${run.seed}, visible share ${run.visible_share}, ${run.burst} event(s) per update`;
	for (const result of run.results.filter((result) => result.view === view)) {
		console.log(
			`| ${label} | ${result.strategy} | ${result.wrong} of ${result.checks} | ${(result.wrong_share * 100).toFixed(1)} % | ` +
				`${result.full_queries} | ${(result.without_full_query_share * 100).toFixed(1)} % | ${result.rows} |`
		);
	}
}

#!/usr/bin/env node
/**
 * Reproduces one race on a real bench: a full refresh of the list that the server answered
 * before a write, but whose response reaches the browser after the realtime update of this
 * write was applied. Seen in the benchmark when the 5-minute refresh of the list was slow.
 *
 *   node bench/stale_refresh_check.js --bench ~/frappe-bench [--site bench.localhost]
 *
 * It creates one Sales Invoice. Exit code 1 if the list is wrong at the end.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import mysql from "mysql2/promise";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const { values: options } = parseArgs({
	options: {
		bench: { type: "string" },
		site: { type: "string", default: "bench.localhost" },
		url: { type: "string", default: "http://bench.localhost:8000" },
		viewer: { type: "string", default: "viewer@example.com" },
		"viewer-password": { type: "string", default: "viewer-Pass-123" },
	},
});
if (!options.bench) {
	console.error("--bench <path of the bench> is required");
	process.exit(1);
}

const STATUSES = ["Unpaid", "Overdue"];
const site_config = JSON.parse(
	readFileSync(join(options.bench, "sites", options.site, "site_config.json"), "utf8")
);
const db = await mysql.createConnection({
	host: "127.0.0.1",
	user: site_config.db_name,
	password: site_config.db_password,
	database: site_config.db_name,
	dateStrings: true,
});
const truth = async () =>
	(
		await db.query(
			"select name from `tabSales Invoice` where status in (?) order by modified desc, name desc limit 20",
			[STATUSES]
		)
	)[0].map((row) => row.name);
const [[{ today }]] = await db.query("select date_format(curdate(), '%Y-%m-%d') as today");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const login = await context.request.post(`${options.url}/api/method/login`, {
	data: { usr: options.viewer, pwd: options["viewer-password"] },
});
if (!login.ok()) throw new Error(`login failed: ${login.status()}`);

const page = await context.newPage();
const filter = encodeURIComponent(JSON.stringify(["in", STATUSES]));
await page.goto(`${options.url}/desk/sales-invoice?status=${filter}`);
await page.waitForFunction(
	() => window.cur_list && cur_list.data?.length && cur_list.refresh_id && frappe.realtime.socket?.connected,
	null,
	{ timeout: 120000 }
);
await page.waitForTimeout(2000);
await page.evaluate(async () => {
	frappe.boot.sysdefaults.event_reduce_list_updates = 1;
	cur_list.sort_selector.set_value("modified", "desc");
	cur_list.sort_by = "modified";
	cur_list.sort_order = "desc";
	cur_list.last_args = null;
	await cur_list.refresh();
});
if (!(await page.evaluate(() => !!cur_list.result_window))) throw new Error("no result window");

const shown = () =>
	page.evaluate(() =>
		[...document.querySelectorAll(".list-row-container .list-row-checkbox")].map((element) =>
			element.getAttribute("data-name")
		)
	);
const check = async (label) => {
	const correct = (await shown()).join() === (await truth()).join();
	console.log(`${label}: ${correct ? "correct" : "WRONG"}`);
	return correct;
};
await check("before the write");

// hold the response of the next full list query
let release;
const released = new Promise((resolve) => (release = resolve));
let held = false;
let answered;
const answered_by_server = new Promise((resolve) => (answered = resolve));
await page.route("**/api/method/frappe.desk.reportview.get", async (route) => {
	if (held || /%22name%22%2C%22in%22/.test(route.request().postData() || "")) return route.continue();
	held = true;
	const response = await route.fetch();
	answered();
	await released;
	await route.fulfill({ response });
});
await page.evaluate(() => {
	cur_list.last_args = null;
	cur_list.refresh();
});
await answered_by_server;

const token = readFileSync(join(here, ".admin_token"), "utf8").trim();
const created = await fetch(`${options.url}/api/resource/Sales%20Invoice`, {
	method: "POST",
	headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
	body: JSON.stringify({
		company: "List Bench Ltd",
		customer: "Bench Customer 01",
		set_posting_time: 1,
		posting_date: today,
		due_date: today,
		items: [{ item_code: "BENCH-SERVICE", qty: 1, rate: 100 }],
		docstatus: 1,
	}),
});
if (!created.ok) throw new Error(`write failed: ${created.status} ${await created.text()}`);
console.log(`created ${(await created.json()).data.name} after the server answered the full query`);

await page.waitForTimeout(4000);
await check("4 s after the write, full query still on its way");
release();
await page.waitForTimeout(1000);
await check("1 s after the response of the full query");
await page.waitForTimeout(4000);
const correct = await check("5 s after the response of the full query");

await browser.close();
await db.end();
process.exit(correct ? 0 : 1);

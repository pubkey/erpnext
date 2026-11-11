#!/usr/bin/env node
/**
 * Calls the refresh of the list (like its 5-minute timer) at fixed offsets around a write
 * on a real bench and checks the list 4.5 s later. Found a change that was dropped when it
 * arrived right after the response of a refresh.
 *
 *   node bench/refresh_timing_check.mjs [more]     (more: after "Load More", 40 rows)
 *
 * The paths of the bench are fixed in this file. It creates 16 Sales Invoices.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import mysql from "mysql2/promise";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const url = "http://bench.localhost:8000";
const LOAD_MORE = process.argv[2] === "more";
const LIMIT = LOAD_MORE ? 40 : 20;
const sc = JSON.parse(readFileSync("/home/user/bench/sites/bench.localhost/site_config.json", "utf8"));
const db = await mysql.createConnection({ host: "127.0.0.1", user: sc.db_name, password: sc.db_password, database: sc.db_name, dateStrings: true });
const truth = async () => (await db.query("select name from `tabSales Invoice` where status in ('Draft','Unpaid','Overdue') order by posting_date desc, name desc limit ?", [LIMIT]))[0].map((r) => r.name);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
await context.request.post(`${url}/api/method/login`, { data: { usr: "viewer@example.com", pwd: "viewer-Pass-123" } });
const page = await context.newPage();
await page.goto(`${url}/desk/sales-invoice?status=${encodeURIComponent(JSON.stringify(["in", ["Draft", "Unpaid", "Overdue"]]))}`);
await page.waitForFunction(() => window.cur_list && cur_list.data?.length && cur_list.refresh_id && frappe.realtime.socket?.connected, null, { timeout: 120000 });
await page.waitForTimeout(2000);
await page.evaluate(async () => {
	frappe.boot.sysdefaults.event_reduce_list_updates = 1;
	cur_list.sort_selector.set_value("posting_date", "desc");
	cur_list.sort_by = "posting_date"; cur_list.sort_order = "desc"; cur_list.last_args = null;
	await cur_list.refresh();
	window.__log = [];
	const log = (what) => window.__log.push([Math.round(performance.now()), what]);
	frappe.realtime.on("list_update", (d) => log("event " + d.name));
	const call = frappe.call;
	frappe.call = function (a) {
		const by_name = JSON.stringify(a.args?.filters || "").includes('"name","in"');
		const kind = (a.method || "").split(".").pop() + (by_name ? " by-name" : "");
		log("send " + kind);
		const p = call.apply(this, arguments);
		p.then(() => log("recv " + kind));
		return p;
	};
});
if (LOAD_MORE) { await page.click(".btn-more"); await page.waitForFunction(() => cur_list.data.length === 40); await page.waitForTimeout(1500); }
console.log("window", await page.evaluate(() => cur_list.result_window && [cur_list.result_window.limit, cur_list.result_window.page_length]));
const shown = () => page.evaluate(() => [...document.querySelectorAll(".list-row-container .list-row-checkbox")].map((e) => e.getAttribute("data-name")));
const token = readFileSync(new URL("./.admin_token", import.meta.url), "utf8").trim();
const [[{ today }]] = await db.query("select date_format(curdate(), '%Y-%m-%d') as today");
for (let offset = -40; offset <= 260; offset += 20) {
	await page.evaluate(() => (window.__log.length = 0));
	const mark = await page.evaluate(() => Math.round(performance.now()));
	const refresh = () => page.evaluate(() => { window.__log.push([Math.round(performance.now()), "TIMER refresh"]); cur_list.refresh(); });
	if (offset < 0) { refresh(); await new Promise((r) => setTimeout(r, -offset)); } else setTimeout(refresh, offset);
	const r = await fetch(`${url}/api/resource/Sales%20Invoice`, { method: "POST", headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ company: "List Bench Ltd", customer: "Bench Customer 01", set_posting_time: 1, posting_date: today, due_date: today, items: [{ item_code: "BENCH-SERVICE", qty: 1, rate: 100 }], docstatus: 1 }) });
	const name = (await r.json()).data.name;
	await page.waitForTimeout(4500);
	const ok = (await shown()).join() === (await truth()).join();
	console.log(`offset ${offset} ${name}: ${ok ? "correct" : "WRONG"}`);
	if (!ok) console.log("   " + (await page.evaluate((m) => window.__log.map(([t, w]) => `${t - m} ${w}`).join(" | "), mark)));
	if (!ok) { await page.evaluate(() => { cur_list.last_args = null; return cur_list.refresh(); }); await page.waitForTimeout(3500); }
}
await browser.close(); await db.end();

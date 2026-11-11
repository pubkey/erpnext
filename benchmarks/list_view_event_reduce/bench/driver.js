#!/usr/bin/env node
/**
 * Browser benchmark on a real bench (frappe + erpnext, MariaDB, Redis, socketio).
 *
 * Opens the real Sales Invoice list in Chromium, once per view and strategy, all on the same
 * site. Then it replays the seeded workload through the REST API as another user and, after
 * every write, compares the rows that each list shows (DOM) with a SQL query on MariaDB.
 *
 *   node bench/driver.js --bench ~/frappe-bench [--site bench.localhost] [--events 2000]
 *       [--seed 2026] [--visible-share 0.4] [--out results/bench.json]
 *
 * The web server must run with bench/serve_instrumented.py (DB query counts per request).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import mysql from "mysql2/promise";
import { create_rng, next_operation } from "./workload.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const { values: options } = parseArgs({
	options: {
		bench: { type: "string" },
		site: { type: "string", default: "bench.localhost" },
		url: { type: "string", default: "http://bench.localhost:8000" },
		events: { type: "string", default: "2000" },
		seed: { type: "string", default: "2026" },
		"visible-share": { type: "string", default: "0.4" },
		out: { type: "string", default: join(here, "../results/bench.json") },
		viewer: { type: "string", default: "viewer@example.com" },
		"viewer-password": { type: "string", default: "viewer-Pass-123" },
	},
});
if (!options.bench) {
	console.error("--bench <path of the bench> is required");
	process.exit(1);
}

const DOCTYPE = "Sales Invoice";
const COMPANY = "List Bench Ltd";
const DEBOUNCE_MS = 2000; // of list_view.js
const OPEN = ["Draft", "Unpaid", "Overdue"];
const VIEWS = {
	"open, posting_date desc, 20 rows": {
		statuses: OPEN,
		sort_by: "posting_date",
		order_by: "posting_date desc, name desc",
		limit: 20,
	},
	"open, posting_date desc, 20 + Load More (40 rows)": {
		statuses: OPEN,
		sort_by: "posting_date",
		order_by: "posting_date desc, name desc",
		limit: 40,
		load_more: true,
	},
	"unpaid + overdue, modified desc, 20 rows": {
		statuses: ["Unpaid", "Overdue"],
		sort_by: "modified",
		order_by: "modified desc, name desc",
		limit: 20,
	},
};
const STRATEGIES = {
	"default (develop behaviour, flag off)": {},
	"default + manual refresh after every event": { manual_refresh: true },
	"EventReduce, buffer 0": { event_reduce: true, buffer_size: 0 },
	"EventReduce + buffer (recommended size)": { event_reduce: true },
	"full refresh on every change": { full_refresh: true },
};
// columns of the list that are compared with the database
const COMPARED_FIELDS = ["status", "posting_date", "due_date", "grand_total", "customer", "docstatus"];

// ---------------------------------------------------------------------------
// database: the ground truth
// ---------------------------------------------------------------------------

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

async function truth_of(view) {
	const [rows] = await db.query(
		`select name, status, posting_date, due_date, grand_total, customer, docstatus
		from \`tabSales Invoice\` where status in (?) order by ${view.order_by} limit ?`,
		[view.statuses, view.limit]
	);
	return rows;
}

async function workload_state() {
	const [[{ today }]] = await db.query("select date_format(curdate(), '%Y-%m-%d') as today");
	const [drafts] = await db.query("select name from `tabSales Invoice` where docstatus = 0 order by name");
	const [open] = await db.query(
		"select name from `tabSales Invoice` where status in ('Unpaid', 'Overdue') order by name"
	);
	const visible = await truth_of(VIEWS["open, posting_date desc, 20 rows"]);
	return {
		today,
		drafts: drafts.map((row) => row.name),
		open: open.map((row) => row.name),
		visible: visible.map((row) => row.name),
	};
}

// ---------------------------------------------------------------------------
// writes: through the REST API, as Administrator
// ---------------------------------------------------------------------------

const token = readFileSync(join(here, ".admin_token"), "utf8").trim();

async function api(method, path, body) {
	const response = await fetch(options.url + path, {
		method,
		headers: {
			Authorization: `token ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 600)}`);
	}
	return JSON.parse(text);
}

const resource = (name) => `/api/resource/${encodeURIComponent(DOCTYPE)}/${encodeURIComponent(name)}`;

async function write(operation) {
	switch (operation.kind) {
		case "new_draft":
		case "new_submitted": {
			const { data } = await api("POST", `/api/resource/${encodeURIComponent(DOCTYPE)}`, {
				company: COMPANY,
				customer: operation.customer,
				set_posting_time: 1,
				posting_date: operation.posting_date,
				due_date: operation.due_date,
				items: [{ item_code: "BENCH-SERVICE", qty: operation.qty, rate: operation.rate }],
				docstatus: operation.kind === "new_submitted" ? 1 : 0,
			});
			return data.name;
		}
		case "move_draft":
			await api("PUT", resource(operation.name), {
				set_posting_time: 1,
				posting_date: operation.posting_date,
				due_date: operation.due_date,
				payment_schedule: [],
			});
			break;
		case "edit_draft":
			await api("PUT", resource(operation.name), { customer: operation.customer });
			break;
		case "submit_draft":
			await api("PUT", resource(operation.name), { docstatus: 1 });
			break;
		case "edit_submitted":
			await api("PUT", resource(operation.name), { po_no: operation.po_no });
			break;
		case "pay": {
			const { message: payment } = await api(
				"POST",
				"/api/method/erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry",
				{ dt: DOCTYPE, dn: operation.name }
			);
			await api("POST", "/api/resource/Payment%20Entry", {
				...payment,
				reference_no: "BENCH",
				reference_date: payment.posting_date,
				docstatus: 1,
			});
			break;
		}
		case "cancel":
			await api("POST", "/api/method/frappe.client.cancel", { doctype: DOCTYPE, name: operation.name });
			break;
		case "delete_draft":
			await api("DELETE", resource(operation.name));
			break;
	}
	return operation.name;
}

// ---------------------------------------------------------------------------
// browser: one page per view and strategy
// ---------------------------------------------------------------------------

// runs in the page before any script of it: records every XMLHttpRequest
function instrument_page() {
	const bench = (window.__bench = { requests: [], inflight: 0, last_activity: 0, timers: [] });
	// the list refreshes itself every 5 minutes: remember when, to tell these refreshes apart
	const set_interval = window.setInterval;
	window.setInterval = function (callback, delay, ...args) {
		const wrapped =
			delay >= 60000 && typeof callback === "function"
				? function () {
						bench.timers.push(performance.now());
						return callback.apply(this, arguments);
				  }
				: callback;
		return set_interval.call(window, wrapped, delay, ...args);
	};
	const open = XMLHttpRequest.prototype.open;
	const send = XMLHttpRequest.prototype.send;
	XMLHttpRequest.prototype.open = function (method, url) {
		this.__url = url;
		return open.apply(this, arguments);
	};
	XMLHttpRequest.prototype.send = function (body) {
		const started = performance.now();
		const request_body = typeof body === "string" ? body : "";
		// sent by the "manual refresh" of the benchmark, not by the realtime update
		const manual = !!bench.manual;
		bench.inflight++;
		bench.last_activity = started;
		this.addEventListener("loadend", () => {
			let rows = null;
			let method = (this.__url.match(/\/api\/method\/([\w.]+)/) || [])[1] || this.__url;
			try {
				const cmd = request_body.match(/(?:^|&)cmd=([^&]+)/);
				if (cmd) method = decodeURIComponent(cmd[1]);
				const message = JSON.parse(this.responseText).message;
				if (message && Array.isArray(message.values)) rows = message.values.length;
			} catch (e) {
				// not JSON
			}
			bench.requests.push({
				method,
				// sent within 3 s after the 5-minute timer of the list fired
				timer: bench.timers.some((fired) => started >= fired && started - fired < 3000),
				manual,
				by_name: /%22name%22%2C%22in%22|"name","in"/.test(request_body),
				request_bytes: request_body.length,
				response_bytes: (this.responseText || "").length,
				rows,
				db_queries: Number(this.getResponseHeader("X-Bench-Db-Queries")),
				server_ms: Number(this.getResponseHeader("X-Bench-Server-Ms")),
				at: Math.round(started),
				ms: performance.now() - started,
			});
			// the rendering happens right after the response
			setTimeout(() => {
				bench.inflight--;
				bench.last_activity = performance.now();
			}, 0);
		});
		return send.apply(this, arguments);
	};
}

const read_page = () => ({
	names: [...document.querySelectorAll(".list-row-container .list-row-checkbox")].map((element) =>
		element.getAttribute("data-name")
	),
	requests: window.__bench.requests.length,
	inflight: window.__bench.inflight,
	idle_ms: performance.now() - window.__bench.last_activity,
});

async function wait_for_idle(page, quiet_ms = 400) {
	await page.waitForFunction(
		(quiet) =>
			window.cur_list &&
			window.__bench.inflight === 0 &&
			performance.now() - window.__bench.last_activity > quiet,
		quiet_ms,
		{ timeout: 60000 }
	);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
await context.addInitScript(instrument_page);
const login = await context.request.post(`${options.url}/api/method/login`, {
	data: { usr: options.viewer, pwd: options["viewer-password"] },
});
if (!login.ok()) throw new Error(`login failed: ${login.status()}`);

const entries = [];
for (const [view_name, view] of Object.entries(VIEWS)) {
	for (const [strategy_name, strategy] of Object.entries(STRATEGIES)) {
		const page = await context.newPage();
		page.on("pageerror", (error) => console.error(`[${strategy_name}] page error: ${error}`));
		const filter = encodeURIComponent(JSON.stringify(["in", view.statuses]));
		await page.goto(`${options.url}/desk/sales-invoice?status=${filter}`);
		// the route is redirected to the workspace of the doctype, which creates the list
		await page.waitForFunction(
			() => window.cur_list && cur_list.data?.length && cur_list.refresh_id && frappe.realtime.socket?.connected,
			null,
			{ timeout: 120000 }
		);
		await wait_for_idle(page, 1500);
		await page.evaluate(
			async ({ view, strategy, debounce_ms }) => {
				if (strategy.event_reduce) {
					// what the boot sends when the System Setting is on
					frappe.boot.sysdefaults.event_reduce_list_updates = 1;
					cur_list.result_window_buffer_size = strategy.buffer_size;
				}
				if (strategy.full_refresh) {
					// benchmark only: the same debounce, but always the full refresh
					cur_list.debounced_refresh = frappe.utils.debounce(() => {
						cur_list.pending_document_refreshes = [];
						cur_list.last_args = null;
						cur_list.refresh();
					}, debounce_ms);
				}
				// like choosing the sort field in the sort menu, but awaitable
				cur_list.sort_selector.set_value(view.sort_by, "desc");
				cur_list.sort_by = view.sort_by;
				cur_list.sort_order = "desc";
				cur_list.last_args = null;
				await cur_list.refresh();
			},
			{ view, strategy, debounce_ms: DEBOUNCE_MS }
		);
		await wait_for_idle(page);
		if (view.load_more) {
			await page.click(".btn-more");
			await page.waitForFunction((limit) => cur_list.data.length === limit, view.limit);
			await wait_for_idle(page);
		}
		const state = await page.evaluate(() => ({
			sort: [cur_list.sort_by, cur_list.sort_order],
			filters: cur_list.get_filters_for_args(),
			rows: cur_list.data.length,
			result_window: cur_list.result_window
				? { limit: cur_list.result_window.limit, page_length: cur_list.result_window.page_length }
				: null,
			requests: window.__bench.requests.length,
		}));
		if (!!strategy.event_reduce !== !!state.result_window) {
			throw new Error(`${view_name} / ${strategy_name}: unexpected result window ${JSON.stringify(state)}`);
		}
		console.log(`opened: ${view_name} / ${strategy_name}: ${JSON.stringify(state)}`);
		entries.push({
			view_name,
			view,
			strategy_name,
			strategy,
			page,
			requests_to_open: state.requests,
			manual_requests: 0,
			events: [],
		});
	}
}

function compare(names, truth) {
	const expected = truth.map((row) => row.name);
	const problems = [];
	if (names.length !== expected.length) problems.push("length");
	if (expected.some((name) => !names.includes(name))) problems.push("missing");
	if (names.some((name) => !expected.includes(name))) problems.push("extra");
	if (!problems.length && names.join() !== expected.join()) problems.push("order");
	return problems;
}

// the values of the rows, only called when the names are right
async function is_stale(page, truth) {
	const shown = await page.evaluate(
		(fields) => cur_list.data.map((row) => fields.map((field) => String(row[field]))),
		COMPARED_FIELDS
	);
	return truth.some((row, index) =>
		COMPARED_FIELDS.some((field, column) => {
			const expected = row[field];
			const actual = shown[index]?.[column];
			return field === "grand_total" ? Number(expected) !== Number(actual) : String(expected) !== actual;
		})
	);
}

for (const entry of entries) {
	const problems = compare((await entry.page.evaluate(read_page)).names, await truth_of(entry.view));
	if (problems.length) {
		throw new Error(`${entry.view_name} / ${entry.strategy_name}: wrong before the first event: ${problems}`);
	}
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

const previous_names = {};
for (const [view_name, view] of Object.entries(VIEWS)) {
	previous_names[view_name] = (await truth_of(view)).map((row) => row.name).join();
}
const rng = create_rng(Number(options.seed));
const total = Number(options.events);
const visible_share = Number(options["visible-share"]);
const operations = [];
const started_at = Date.now();

function save(finished) {
	writeFileSync(
		options.out,
		JSON.stringify({
			kind: "real bench (browser + MariaDB)",
			finished,
			seed: Number(options.seed),
			visible_share,
			debounce_ms: DEBOUNCE_MS,
			duration_s: Math.round((Date.now() - started_at) / 1000),
			operations,
			lists: entries.map((entry) => ({
				view: entry.view_name,
				strategy: entry.strategy_name,
				requests_to_open: entry.requests_to_open,
				manual_requests: entry.manual_requests,
				events: entry.events,
				requests: entry.all_requests,
			})),
		})
	);
}

for (let index = 0; index < total; index++) {
	const operation = next_operation(rng, await workload_state(), visible_share);
	const write_started = performance.now();
	let name;
	try {
		name = await write(operation);
	} catch (error) {
		console.error(`event ${index + 1} ${JSON.stringify(operation)} failed: ${error.message}`);
		operations.push({ ...operation, failed: true });
		for (const entry of entries) entry.events.push(null);
		continue;
	}
	const saved = performance.now();
	operations.push({ ...operation, name, write_ms: Math.round(saved - write_started) });

	const truths = {};
	const changed = {};
	for (const [view_name, view] of Object.entries(VIEWS)) {
		truths[view_name] = await truth_of(view);
		const names = truths[view_name].map((row) => row.name).join();
		changed[view_name] = names !== previous_names[view_name];
		previous_names[view_name] = names;
	}

	// watch the lists until they are quiet
	const watch = entries.map(() => ({ correct_at: null, wrong_since_correct: false, requests: null }));
	let quiet_since = null;
	let states;
	for (;;) {
		states = await Promise.all(entries.map((entry) => entry.page.evaluate(read_page)));
		const now = performance.now();
		states.forEach((state, i) => {
			const correct = !compare(state.names, truths[entries[i].view_name]).length;
			if (correct && watch[i].correct_at === null) watch[i].correct_at = now - saved;
			if (!correct) watch[i].correct_at = null;
		});
		const quiet = states.every((state) => state.inflight === 0 && state.idle_ms > 400);
		quiet_since = quiet ? quiet_since ?? now : null;
		if (now - saved > DEBOUNCE_MS + 700 && quiet) break;
		if (now - saved > 20000) {
			console.error(`event ${index + 1}: lists not quiet after 20 s`);
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const truth = truths[entry.view_name];
		const problems = compare(states[i].names, truth);
		if (!problems.length && (await is_stale(entry.page, truth))) problems.push("stale");
		entry.events.push({
			problems,
			// the write changed which rows the query returns, or their order
			changed: changed[entry.view_name],
			// ms from the response of the write to the first moment the list showed the right rows
			// (and kept them); null if it never did
			correct_ms: problems.length ? null : Math.round(watch[i].correct_at),
			requests: states[i].requests,
		});
	}

	// "manual refresh": the user presses the refresh button, after the check
	const manual = entries.filter((entry) => entry.strategy.manual_refresh);
	await Promise.all(
		manual.map(async (entry) => {
			const before = await entry.page.evaluate(() => window.__bench.requests.length);
			await entry.page.evaluate(() => {
				window.__bench.manual = true;
				cur_list.last_args = null;
				return cur_list.refresh();
			});
			await wait_for_idle(entry.page, 150);
			await entry.page.evaluate(() => (window.__bench.manual = false));
			entry.manual_requests += (await entry.page.evaluate(() => window.__bench.requests.length)) - before;
		})
	);

	if ((index + 1) % 25 === 0) {
		const wrong = entries.map((entry) => entry.events.filter((event) => event?.problems.length).length);
		console.log(
			`${index + 1}/${total} events, ${Math.round((Date.now() - started_at) / 1000)} s, wrong: ${wrong.join(" ")}`
		);
	}
	if ((index + 1) % 100 === 0 || index + 1 === total) {
		for (const entry of entries) {
			entry.all_requests = await entry.page.evaluate(() => window.__bench.requests);
		}
		save(index + 1 === total);
	}
}

await browser.close();
await db.end();
console.log(`done, results in ${options.out}`);

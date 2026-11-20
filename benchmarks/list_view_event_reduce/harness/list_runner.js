/**
 * One list view of the harness: the extracted ListView class, connected to a MemorySite.
 */
const DOCTYPE = "Sales Invoice";
const TABLE = "`tabSales Invoice`";
export const LIST_FIELDS = [
	"name",
	"status",
	"posting_date",
	"due_date",
	"grand_total",
	"customer",
	"modified",
	"docstatus",
];
const FIELDTYPES = {
	status: "Select",
	posting_date: "Date",
	due_date: "Date",
	grand_total: "Currency",
	customer: "Link",
};

export function get_order_by(sort_by, sort_order) {
	// like get_sql_string() of frappe/public/js/frappe/ui/sort_selector.js
	const column = `${TABLE}.\`${sort_by}\` ${sort_order}`;
	return ["name", "creation", "modified"].includes(sort_by)
		? column
		: `${column}, ${TABLE}.\`name\` ${sort_order}`;
}

export class ListRunner {
	/**
	 * @param source from load_list_view()
	 * @param site the MemorySite
	 * @param view { filters, sort_by, sort_order, page_length, load_more }
	 * @param options { event_reduce: use the feature flag, buffer_size, full_refresh:
	 *     refresh the whole list on every change }
	 */
	constructor(source, site, view, options = {}) {
		this.site = site;
		this.view = view;
		this.options = options;
		this.requests = [];
		this.pending = [];
		this.handlers = {};

		const env = {
			cur_list: null,
			cint: (value) => parseInt(value) || 0,
			__: (text) => text,
			// no_change() of the list: no timers in the harness
			setTimeout: () => {},
			ensure_list_virtualization_loaded: () => Promise.resolve(),
			frappe: {
				boot: {
					user_info: {},
					sysdefaults: { event_reduce_list_updates: options.event_reduce ? 1 : 0 },
				},
				call: (call_args) => {
					const first = this.site.requests.length;
					const promise = this.site.call(call_args);
					this.requests.push(...this.site.requests.slice(first));
					this.pending.push(promise);
					return promise;
				},
				utils: {
					dict: (keys, values) =>
						values.map((row) => Object.fromEntries(keys.map((key, i) => [key, row[i]]))),
				},
				get_route: () => ["List", DOCTYPE, "List"],
				realtime: {
					doctype_subscribe: () => {},
					doctype_unsubscribe: () => {},
					off: (event) => delete this.handlers[event],
					on: (event, handler) => (this.handlers[event] = handler),
				},
				meta: { get_docfield: (doctype, fieldname) => ({ fieldtype: FIELDTYPES[fieldname] }) },
				model: { get_full_column_name: (fieldname) => `${TABLE}.\`${fieldname}\`` },
			},
		};
		const ListView = source.create_class(env);
		const list = (this.list = new ListView());
		env.cur_list = list;
		Array.prototype.uniqBy ??= function (get_key) {
			const seen = new Set();
			return this.filter((item) => !seen.has(get_key(item)) && seen.add(get_key(item)));
		};
		Object.assign(list, {
			doctype: DOCTYPE,
			view: "List",
			view_name: "List",
			method: "frappe.desk.reportview.get",
			fields: LIST_FIELDS.map((fieldname) => [fieldname, DOCTYPE]),
			filter_area: {
				get: () => view.filters.map((filter) => [...filter]),
				is_being_edited: () => false,
			},
			sort_selector: { get_sql_string: () => get_order_by(view.sort_by, view.sort_order) },
			sort_by: view.sort_by,
			sort_order: view.sort_order,
			start: 0,
			page_length: view.page_length,
			selected_page_count: view.page_length,
			virtualization_threshold: 2000,
			checked_docnames: new Set(),
			list_view_settings: {},
			meta: {},
			settings: {},
			data: [],
			// the harness decides when the debounce fires, see flush()
			debounced_refresh: () => {},
			result_window_buffer_size: options.buffer_size,
		});
	}

	async idle() {
		// wait for the requests and everything that runs after them
		let seen;
		do {
			seen = this.pending.length;
			await Promise.all(this.pending);
			await new Promise((resolve) => setImmediate(resolve));
		} while (seen !== this.pending.length);
	}

	async open() {
		await this.list.refresh();
		await this.idle();
		if (this.view.load_more) {
			// what the "Load More" button does
			this.list.start = this.list.data.length;
			this.list.page_length = this.list.selected_page_count;
			await this.list.refresh();
			await this.idle();
		}
		this.visible_length = this.list.page_length;
		this.requests_to_open = this.requests.length;
	}

	// the realtime event of the server: { doctype, name, user }
	notify(name) {
		this.handlers.list_update({ doctype: DOCTYPE, name, user: "Administrator" });
	}

	// the debounce fires
	async flush() {
		if (this.options.full_refresh) {
			this.list.pending_document_refreshes = [];
			this.list.last_args = null;
			await this.list.refresh();
		} else {
			this.list.process_document_refreshes();
		}
		await this.idle();
	}

	truth() {
		return this.site.query(
			this.view.filters,
			get_order_by(this.view.sort_by, this.view.sort_order),
			0,
			this.visible_length
		);
	}
}

/**
 * Compares the rows of the list with the rows of the query.
 * @returns null if they are the same, or what is wrong
 */
export function compare(shown, expected, fields = LIST_FIELDS) {
	const shown_names = shown.map((row) => String(row.name));
	const expected_names = expected.map((row) => String(row.name));
	const problems = [];
	if (shown_names.length !== expected_names.length) problems.push("length");
	if (expected_names.some((name) => !shown_names.includes(name))) problems.push("missing");
	if (shown_names.some((name) => !expected_names.includes(name))) problems.push("extra");
	if (!problems.length && shown_names.join() !== expected_names.join()) problems.push("order");
	if (!problems.length) {
		const stale = expected.some((row, index) =>
			fields.some((fieldname) => String(shown[index][fieldname]) !== String(row[fieldname]))
		);
		if (stale) problems.push("stale");
	}
	return problems.length ? problems : null;
}

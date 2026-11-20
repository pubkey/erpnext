import {
	applyChangeEventsToResultWindowBuffer,
	createResultWindowBuffer,
	getRecommendedResultWindowBufferSize,
	getResultWindowBufferResults,
	resetResultWindowBuffer,
} from "event-reduce-js";

const NUMERIC_FIELDTYPES = ["Int", "Float", "Currency", "Percent", "Duration", "Check", "Rating"];
const DATE_FIELDTYPES = ["Date", "Datetime", "Time"];
// MariaDB compares names without case and accents (utf8mb4_unicode_ci)
const name_collator = new Intl.Collator("en", { sensitivity: "base" });

// Sorts like the list query. Returns null if the order depends on the database collation.
function get_sort_comparator(listview) {
	const { sort_by, sort_order, doctype } = listview;
	const fieldtype = ["creation", "modified"].includes(sort_by)
		? "Datetime"
		: frappe.meta.get_docfield(doctype, sort_by)?.fieldtype;
	let to_value;
	if (NUMERIC_FIELDTYPES.includes(fieldtype)) {
		to_value = (value) => (value == null || value === "" ? -Infinity : Number(value));
	} else if (DATE_FIELDTYPES.includes(fieldtype)) {
		to_value = (value) => String(value ?? "");
	} else {
		return null;
	}
	const direction = sort_order === "desc" ? -1 : 1;
	return (a, b) => {
		const [value_a, value_b] = [to_value(a[sort_by]), to_value(b[sort_by])];
		const result = value_a < value_b ? -1 : value_a > value_b ? 1 : name_collator.compare(a.name, b.name);
		return result * direction > 0 ? 1 : -1;
	};
}

/**
 * Keeps the rows of a list view correct on realtime updates with EventReduce. The list queries
 * some rows more than it shows, so that it can fill up when a row leaves, and only runs the
 * full query again when EventReduce cannot tell the new rows.
 */
erpnext.utils.setup_list_event_reduce = function (listview) {
	if (listview.view_name !== "List") return;

	const original = {};
	for (const method of [
		"get_call_args",
		"prepare_data",
		"setup_realtime_updates",
		"process_document_refreshes",
	]) {
		original[method] = listview[method].bind(listview);
	}
	let buffer = null; // rows of the list and some rows after them, null if they are not known
	let comparator = null;
	let changed = []; // documents that changed after the last full query was sent
	let queue = Promise.resolve();

	const get_limit = () => listview.start + listview.page_length;
	const is_list_query = (call_args) => call_args.method === "frappe.desk.reportview.get";

	// A change that is ignored by the list view makes the rows outdated.
	const on_list_update = (data) => {
		if (data?.doctype !== listview.doctype) return;
		if (!data.name || listview.checked_docnames.size || listview.avoid_realtime_update()) {
			buffer = null;
		} else {
			changed.push(data.name);
		}
	};

	listview.get_call_args = function () {
		const call_args = original.get_call_args();
		comparator = is_list_query(call_args) && get_sort_comparator(listview);
		if (comparator) {
			// all rows of the list, also after "Load More", and the rows of the buffer
			const limit = get_limit();
			call_args.args.start = 0;
			call_args.args.page_length = limit + getRecommendedResultWindowBufferSize(limit);
		}
		changed = [];
		return call_args;
	};

	listview.prepare_data = function (r) {
		buffer = null;
		if (!comparator) return original.prepare_data(r);

		const start = listview.start;
		listview.start = 0;
		original.prepare_data(r);
		listview.start = start;

		const limit = get_limit();
		buffer = createResultWindowBuffer(
			{
				primaryKey: "name",
				sortFields: [listview.sort_by, "name"],
				limit,
				// the server filters: it only returns the changed documents that match
				queryMatcher: () => true,
				sortComparator: comparator,
			},
			{ limitBufferSize: getRecommendedResultWindowBufferSize(limit) }
		);
		resetResultWindowBuffer(buffer, listview.data);
		listview.data = getResultWindowBufferResults(buffer);
		// the response can be older than these changes
		if (changed.length) apply_changes([...new Set(changed)]);
		changed = [];
	};

	listview.setup_realtime_updates = function () {
		// a change that arrived while the list was rendered is not dropped
		const pending = listview.pending_document_refreshes;
		original.setup_realtime_updates();
		listview.pending_document_refreshes = pending || [];
		frappe.realtime.off("list_update", on_list_update);
		frappe.realtime.on("list_update", on_list_update);
	};

	listview.process_document_refreshes = function () {
		const names = [...new Set(listview.pending_document_refreshes.map((d) => d.name))];
		if (!names.length) return;
		if (cur_list !== listview || frappe.get_route()[0] !== "List") {
			// the list view stops its realtime updates until it is shown again
			buffer = null;
			return original.process_document_refreshes();
		}
		listview.pending_document_refreshes = [];
		return apply_changes(names);
	};
	// the list view bound its own method in the constructor
	listview.debounced_refresh = frappe.utils.debounce(
		listview.process_document_refreshes,
		listview.is_large_table ? 15000 : 2000
	);

	function refresh() {
		listview.last_args = null;
		return listview.refresh();
	}

	function apply_changes(names) {
		// one after the other, so the changes are applied in order
		queue = queue.then(() => {
			const current = buffer;
			if (!current) return refresh();

			const call_args = original.get_call_args();
			call_args.args.filters.push([listview.doctype, "name", "in", names]);
			call_args.args.start = 0;
			call_args.args.page_length = names.length;

			return frappe.call(call_args).then(({ message }) => {
				if (current !== buffer) return refresh();

				const rows = message ? frappe.utils.dict(message.keys, message.values) : [];
				const change_events = [];
				for (const id of names) {
					const doc = rows.find((row) => row.name === id) || null;
					// a document that is not in the buffer did not match or sorted after it,
					// both behave like an insert
					const previous = current.keyDocumentMap.get(id) || null;
					if (doc || previous) {
						const operation = !previous ? "INSERT" : doc ? "UPDATE" : "DELETE";
						change_events.push({ operation, id, doc, previous });
					}
				}
				const result = applyChangeEventsToResultWindowBuffer(current, change_events);
				if (result.runFullQueryAgain) {
					buffer = null;
					return refresh();
				}
				if (!result.changed) return;

				listview.data = result.results;
				if (listview.checked_docnames.size) listview.set_rows_as_checked();
				listview.toggle_result_area();
				listview.render_list();
			});
		});
		queue = queue.catch(() => (buffer = null));
		return queue;
	}
};

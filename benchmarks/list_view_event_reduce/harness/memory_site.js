/**
 * In-memory stand-in for the site: the invoices, the writes of the workload and
 * the list query (frappe.desk.reportview.get). This is the ground truth of the harness.
 * It is NOT Frappe: it only models what the list of the benchmark needs.
 */
const TABLE = "`tabSales Invoice`";

export class MemorySite {
	constructor(invoices, today) {
		this.today = today;
		this.docs = new Map(invoices.map((doc) => [doc.name, { ...doc }]));
		this.clock = 0;
		this.series = Math.max(0, ...invoices.map((doc) => Number(doc.name.split("-").pop())));
		this.requests = [];
	}

	// ---- writes, with the status rules of a Sales Invoice without taxes ----

	touch(doc) {
		// like the real `modified`, later writes get a later timestamp
		this.clock++;
		doc.modified = `9999-01-01 00:00:00.${String(this.clock).padStart(6, "0")}`;
	}

	open_status(doc) {
		return doc.due_date < this.today ? "Overdue" : "Unpaid";
	}

	apply(operation) {
		const doc = operation.name ? this.docs.get(operation.name) : null;
		switch (operation.kind) {
			case "new_draft":
			case "new_submitted": {
				this.series++;
				const year = this.today.slice(0, 4);
				const created = {
					name: `ACC-SINV-${year}-${String(this.series).padStart(5, "0")}`,
					customer: operation.customer,
					posting_date: operation.posting_date,
					due_date: operation.due_date,
					grand_total: operation.qty * operation.rate,
					status: "Draft",
					docstatus: 0,
					po_no: null,
				};
				if (operation.kind === "new_submitted") {
					created.docstatus = 1;
					created.status = this.open_status(created);
				}
				this.touch(created);
				this.docs.set(created.name, created);
				return created.name;
			}
			case "move_draft":
				doc.posting_date = operation.posting_date;
				doc.due_date = operation.due_date;
				break;
			case "edit_draft":
				doc.customer = operation.customer;
				break;
			case "submit_draft":
				doc.docstatus = 1;
				doc.status = this.open_status(doc);
				break;
			case "pay":
				doc.status = "Paid";
				break;
			case "cancel":
				doc.docstatus = 2;
				doc.status = "Cancelled";
				break;
			case "edit_submitted":
				doc.po_no = operation.po_no;
				break;
			case "delete_draft":
				this.docs.delete(doc.name);
				// like Frappe: deleting the newest document gives its number back to the series
				if (Number(doc.name.split("-").pop()) === this.series) this.series--;
				return doc.name;
		}
		this.touch(doc);
		return doc.name;
	}

	// ---- reads ----

	workload_state(visible_filters, visible_order_by, visible_count) {
		const names = [...this.docs.keys()].sort();
		return {
			today: this.today,
			drafts: names.filter((name) => this.docs.get(name).docstatus === 0),
			open: names.filter((name) => ["Unpaid", "Overdue"].includes(this.docs.get(name).status)),
			visible: this.query(visible_filters, visible_order_by, 0, visible_count).map(
				(doc) => doc.name
			),
		};
	}

	matches(doc, [, fieldname, operator, value]) {
		const actual = doc[fieldname];
		switch (operator.toLowerCase()) {
			case "=":
				return actual === value;
			case "!=":
				return actual !== value;
			case "in":
				return value.includes(actual);
			case "not in":
				return !value.includes(actual);
			case ">":
				return actual > value;
			case "<":
				return actual < value;
		}
		throw new Error(`MemorySite does not know the operator ${operator}`);
	}

	query(filters, order_by, start, page_length) {
		// order_by looks like: `tabSales Invoice`.`posting_date` desc, `tabSales Invoice`.`name` desc
		const sort = order_by.split(",").map((part) => {
			const [, fieldname, direction] = part.trim().match(/\.`(\w+)` (asc|desc)$/);
			return [fieldname, direction === "desc" ? -1 : 1];
		});
		const rows = [...this.docs.values()].filter((doc) =>
			filters.every((filter) => this.matches(doc, filter))
		);
		rows.sort((a, b) => {
			for (const [fieldname, direction] of sort) {
				if (a[fieldname] !== b[fieldname]) {
					return (a[fieldname] < b[fieldname] ? -1 : 1) * direction;
				}
			}
			return 0;
		});
		return rows.slice(start, page_length ? start + page_length : undefined);
	}

	// frappe.call({ method: "frappe.desk.reportview.get", args })
	call({ method, args }) {
		if (method !== "frappe.desk.reportview.get") {
			throw new Error(`MemorySite does not know the method ${method}`);
		}
		const keys = args.fields.map((field) => field.replace(`${TABLE}.`, "").replace(/`/g, ""));
		const rows = this.query(args.filters, args.order_by, args.start, args.page_length);
		const message = { keys, values: rows.map((doc) => keys.map((key) => doc[key])) };
		const is_full = !args.filters.some((filter) => filter[1] === "name");
		this.requests.push({
			full: is_full,
			rows: rows.length,
			bytes: JSON.stringify(args).length + JSON.stringify(message).length,
		});
		return Promise.resolve({ message: structuredClone(message) });
	}
}

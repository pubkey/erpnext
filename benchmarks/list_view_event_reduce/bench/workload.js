/**
 * The seeded workload: which write happens next.
 * Used by the Node harness (in memory) and by the browser benchmark (real bench),
 * so both replay the same sequence when they start from the same invoices.
 */

// small seeded random number generator (mulberry32)
export function create_rng(seed) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		int: (min, max) => min + Math.floor(next() * (max - min + 1)),
		pick: (list) => list[Math.floor(next() * list.length)],
	};
}

export const MAX_AGE_DAYS = 300;

// share of each write, in percent
export const OPERATIONS = [
	["new_draft", 20], // insert, matches the filter of the "open invoices" list
	["new_submitted", 12], // insert as Unpaid or Overdue
	["submit_draft", 14], // update: Draft -> Unpaid / Overdue
	["move_draft", 10], // update of the sort field (posting_date)
	["edit_draft", 8], // update of another column (customer)
	["pay", 14], // update: Unpaid / Overdue -> Paid, leaves the filter
	["cancel", 8], // update: -> Cancelled, leaves the filter
	["delete_draft", 8], // delete
	["edit_submitted", 6], // update of a field that is not a list column (po_no)
];

function add_days(date, days) {
	const d = new Date(date + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/**
 * @param rng from create_rng()
 * @param state { today, drafts, open, visible }: names of the draft invoices and of the
 *     submitted unpaid invoices, both sorted by name, and the names of the first page
 * @param visible_share share of the writes on existing invoices that pick an invoice
 *     of the first page (if one fits), like a user who works on what they see
 */
export function next_operation(rng, state, visible_share) {
	let roll = rng.next() * 100;
	let kind = OPERATIONS[OPERATIONS.length - 1][0];
	for (const [name, weight] of OPERATIONS) {
		if (roll < weight) {
			kind = name;
			break;
		}
		roll -= weight;
	}
	const on_first_page = rng.next() < visible_share;
	const target_roll = rng.next();
	const recent = rng.next() < 0.7;
	const age = recent ? rng.int(0, 3) : rng.int(0, MAX_AGE_DAYS);
	const posting_date = add_days(state.today, -age);
	const customer = `Bench Customer ${String(rng.int(1, 20)).padStart(2, "0")}`;
	const qty = rng.int(1, 20);
	const rate = rng.int(5, 50) * 10;

	const pick = (candidates) => {
		const visible = on_first_page ? state.visible.filter((n) => candidates.includes(n)) : [];
		const pool = visible.length ? visible : candidates;
		return pool[Math.floor(target_roll * pool.length)];
	};

	const needs_draft = ["submit_draft", "move_draft", "edit_draft", "delete_draft"].includes(kind);
	const needs_open = ["pay", "cancel", "edit_submitted"].includes(kind);
	if ((needs_draft && !state.drafts.length) || (needs_open && !state.open.length)) {
		kind = "new_draft";
	}

	switch (kind) {
		case "new_draft":
		case "new_submitted":
			return { kind, posting_date, due_date: add_days(posting_date, 30), customer, qty, rate };
		case "move_draft":
			return {
				kind,
				name: pick(state.drafts),
				posting_date,
				due_date: add_days(posting_date, 30),
			};
		case "edit_draft":
			return { kind, name: pick(state.drafts), customer };
		case "submit_draft":
		case "delete_draft":
			return { kind, name: pick(state.drafts) };
		case "edit_submitted":
			return { kind, name: pick(state.open), po_no: `PO-${rng.int(1000, 9999)}` };
		default:
			return { kind, name: pick(state.open) };
	}
}

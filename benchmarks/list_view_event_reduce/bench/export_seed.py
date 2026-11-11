"""Writes the seeded Sales Invoices as JSON, the dataset of the Node harness.

    ../env/bin/python <path>/bench/export_seed.py bench.localhost <path>/seed/invoices-5000-seed2026.json
"""
import json
import sys

import frappe
from frappe.utils import today

frappe.init(sys.argv[1])
frappe.connect()
rows = frappe.db.sql(
	"""select name, status, posting_date, due_date, grand_total, customer, modified, docstatus, po_no
	from `tabSales Invoice` order by name""",
	as_dict=True,
)
for row in rows:
	row.posting_date = str(row.posting_date)
	row.due_date = str(row.due_date)
	row.modified = str(row.modified)
with open(sys.argv[2], "w") as f:
	json.dump({"today": today(), "invoices": rows}, f, separators=(",", ":"))
print(len(rows), "invoices")

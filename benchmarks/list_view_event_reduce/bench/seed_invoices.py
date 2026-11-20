"""Seeds Sales Invoices through the normal document API (validations, GL entries, payments).

Run from the bench's sites directory:
    ../env/bin/python <path>/bench/seed_invoices.py bench.localhost 5000 2026

The same seed gives the same invoices in the same order, relative to the current date.
"""
import random
import sys
import time

import frappe
from frappe.utils import add_days, today

SITE = sys.argv[1] if len(sys.argv) > 1 else "bench.localhost"
COUNT = int(sys.argv[2]) if len(sys.argv) > 2 else 5000
SEED = int(sys.argv[3]) if len(sys.argv) > 3 else 2026
COMPANY = "List Bench Ltd"
MAX_AGE_DAYS = 300

frappe.init(SITE)
frappe.connect()
frappe.set_user("Administrator")
frappe.flags.mute_emails = True

from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

rng = random.Random(SEED)
start = time.time()
existing = frappe.db.count("Sales Invoice")
if existing:
	sys.exit(f"{existing} Sales Invoices exist already, seed an empty site")

for i in range(COUNT):
	posting_date = add_days(today(), -rng.randint(0, MAX_AGE_DAYS))
	kind = rng.choices(["paid", "open", "draft", "cancelled"], weights=[62, 20, 10, 8])[0]
	doc = frappe.get_doc(
		{
			"doctype": "Sales Invoice",
			"company": COMPANY,
			"customer": f"Bench Customer {rng.randint(1, 20):02d}",
			"set_posting_time": 1,
			"posting_date": posting_date,
			"due_date": add_days(posting_date, 30),
			"items": [
				{"item_code": "BENCH-SERVICE", "qty": rng.randint(1, 20), "rate": rng.randint(5, 50) * 10}
			],
		}
	)
	doc.insert()
	if kind != "draft":
		doc.submit()
	if kind == "paid":
		payment = get_payment_entry("Sales Invoice", doc.name)
		payment.reference_no = f"SEED-{i}"
		payment.reference_date = today()
		payment.insert()
		payment.submit()
	elif kind == "cancelled":
		doc.cancel()
	if i % 50 == 49:
		frappe.db.commit()
	if i % 500 == 499:
		print(f"{i + 1} invoices, {time.time() - start:.0f} s", flush=True)

frappe.db.commit()
print(frappe.db.sql("select status, count(*) from `tabSales Invoice` group by status order by status"))

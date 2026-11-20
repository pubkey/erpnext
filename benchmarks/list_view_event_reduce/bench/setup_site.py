"""Prepares a fresh ERPNext site for the benchmark: company, customers and a service item.

Run from the bench's sites directory:
    ../env/bin/python <path>/bench/setup_site.py bench.localhost
"""
import os
import sys

import frappe

SITE = sys.argv[1] if len(sys.argv) > 1 else "bench.localhost"
COMPANY = "List Bench Ltd"

frappe.init(SITE)
frappe.connect()
frappe.set_user("Administrator")

if not frappe.is_setup_complete():
	from frappe.desk.page.setup_wizard.setup_wizard import setup_complete

	setup_complete(
		{
			"currency": "USD",
			"full_name": "Bench Admin",
			"company_name": COMPANY,
			"timezone": "Etc/UTC",
			"company_abbr": "LB",
			"industry": "Services",
			"country": "United States",
			"fy_start_date": "2026-01-01",
			"fy_end_date": "2026-12-31",
			"language": "english",
			"company_tagline": "Benchmark",
			"email": "bench@example.com",
			"password": "admin",
			"chart_of_accounts": "Standard",
		}
	)
	frappe.db.commit()

for i in range(1, 21):
	name = f"Bench Customer {i:02d}"
	if not frappe.db.exists("Customer", name):
		frappe.get_doc(
			{"doctype": "Customer", "customer_name": name, "customer_type": "Company"}
		).insert()

if not frappe.db.exists("Item", "BENCH-SERVICE"):
	frappe.get_doc(
		{
			"doctype": "Item",
			"item_code": "BENCH-SERVICE",
			"item_name": "Bench Service",
			"item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
			"stock_uom": "Nos",
			"is_stock_item": 0,
		}
	).insert()

# a second user, so the list is watched by someone else than the user who writes
if not frappe.db.exists("User", "viewer@example.com"):
	user = frappe.get_doc(
		{
			"doctype": "User",
			"email": "viewer@example.com",
			"first_name": "Viewer",
			"send_welcome_email": 0,
			"new_password": "viewer-Pass-123",
			"roles": [{"role": "Accounts User"}, {"role": "Sales User"}],
		}
	).insert()

# API key for the writes of the benchmark
admin = frappe.get_doc("User", "Administrator")
api_secret = frappe.generate_hash(length=15)
admin.api_key = admin.api_key or frappe.generate_hash(length=15)
admin.api_secret = api_secret
admin.save()
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".admin_token"), "w") as f:
	f.write(f"{admin.api_key}:{api_secret}")

frappe.db.commit()
print("company:", frappe.db.get_value("Company", COMPANY, ["name", "default_currency"]))
print("customers:", frappe.db.count("Customer"), "setup complete:", frappe.is_setup_complete())

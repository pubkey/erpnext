"""Development web server of the bench, with two extra response headers per request:

    X-Bench-Db-Queries   SQL statements that the request sent through frappe.db.sql
    X-Bench-Server-Ms    time the request spent in the server

This is benchmark instrumentation. It changes no code of Frappe and is not part of the change.
Run from the bench's sites directory:
    ../env/bin/python <path>/bench/serve_instrumented.py bench.localhost 8000
"""
import sys
import threading
import time

import frappe.app
from frappe.database.database import Database

counter = threading.local()
original_sql = Database.sql


def counted_sql(self, *args, **kwargs):
	counter.queries = getattr(counter, "queries", 0) + 1
	return original_sql(self, *args, **kwargs)


Database.sql = counted_sql
inner = frappe.app.application


def application(environ, start_response):
	counter.queries = 0
	started = time.perf_counter()

	def instrumented_start_response(status, headers, exc_info=None):
		headers.append(("X-Bench-Db-Queries", str(counter.queries)))
		headers.append(("X-Bench-Server-Ms", f"{(time.perf_counter() - started) * 1000:.1f}"))
		return start_response(status, headers, exc_info)

	return inner(environ, instrumented_start_response)


frappe.app.application = application
frappe.app.serve(
	port=int(sys.argv[2]) if len(sys.argv) > 2 else 8000,
	site=sys.argv[1] if len(sys.argv) > 1 else None,
	sites_path=".",
	no_reload=True,
)

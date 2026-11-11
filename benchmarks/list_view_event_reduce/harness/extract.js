/**
 * Builds a list view class for Node out of the real, unmodified source of
 * frappe/public/js/frappe/list/base_list.js and list_view.js.
 * Only the methods of the realtime update and of the list query are taken; everything
 * that draws (DOM, jQuery) is replaced by empty methods.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LIST_DIR = "frappe/public/js/frappe/list";

function read_source(frappe_path, git_ref, file) {
	const path = `${LIST_DIR}/${file}`;
	if (!git_ref) {
		return readFileSync(join(frappe_path, path), "utf8");
	}
	return execFileSync("git", ["-C", frappe_path, "show", `${git_ref}:${path}`], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
}

// the text of a class method: from "\tname(...) {" to the next line that is "\t}"
export function extract_method(source, name) {
	const start = source.search(new RegExp(`^\\t${name}\\(.*\\) \\{$`, "m"));
	if (start === -1) return null;
	const end = source.indexOf("\n\t}\n", start);
	return source.slice(start, end + 4);
}

const BASE_LIST_METHODS = [
	"get_fields",
	"get_group_by",
	"get_filters_for_args",
	"get_args",
	"get_call_args",
	"refresh",
	"no_change",
	"prepare_data",
	"reset_defaults",
];
const LIST_VIEW_METHODS = [
	"get_args",
	"refresh",
	"setup_realtime_updates",
	"process_document_refreshes",
	"avoid_realtime_update",
	// only on the branch with EventReduce:
	"create_result_window",
	"get_call_args",
	"prepare_data",
	"apply_changes_to_result_window",
];
const NO_OPS = [
	"freeze",
	"toggle_result_area",
	"before_render",
	"render",
	"after_render",
	"set_result_height",
	"render_header",
	"apply_column_widths",
	"render_count",
	"update_checkbox",
	"update_url_with_filters",
	"apply_styles_basedon_dropdown",
	"render_list",
	"remove_list_items",
	"set_rows_as_checked",
];

/**
 * @param frappe_path path of a frappe checkout
 * @param git_ref take the files from this git ref (like "origin/develop"),
 *     or from the working tree if not set
 * @returns { create_class, has_event_reduce, methods }
 */
export async function load_list_view(frappe_path, git_ref) {
	const base_source = read_source(frappe_path, git_ref, "base_list.js");
	const list_source = read_source(frappe_path, git_ref, "list_view.js");
	const base_methods = BASE_LIST_METHODS.map((name) => extract_method(base_source, name));
	const list_methods = LIST_VIEW_METHODS.map((name) => extract_method(list_source, name));
	if (base_methods.includes(null)) {
		throw new Error("base_list.js changed: a method of the harness is missing");
	}

	let ListResultWindow = null;
	if (list_source.includes("./list_result_window")) {
		// the real module of the branch, with event-reduce-js from frappe's node_modules
		const url = pathToFileURL(join(frappe_path, LIST_DIR, "list_result_window.js"));
		ListResultWindow = (await import(url)).ListResultWindow;
	}

	const class_source = `
		with (env) {
			class BaseList {
				${NO_OPS.map((name) => `${name}() {}`).join("\n")}
				${base_methods.join("\n")}
			}
			class ListView extends BaseList {
				${list_methods.filter(Boolean).join("\n")}
			}
			return ListView;
		}`;
	const create_class = new Function("env", class_source);
	return {
		// env holds what the source expects as globals: frappe, cur_list, cint, __, setTimeout
		// and ensure_list_virtualization_loaded
		create_class: (env) => create_class(Object.assign(env, { ListResultWindow })),
		has_event_reduce: !!ListResultWindow,
		methods: LIST_VIEW_METHODS.filter((name, index) => list_methods[index]),
	};
}

import type { FilesApi } from "@statewalker/webrun-files";
import type { ToolSet } from "ai";
import { createCountLinesTool } from "./count-lines.js";
import { createCreateDirectoryTool } from "./create-directory.js";
import { createDeleteFileTool } from "./delete-file.js";
import { createEditFileTool } from "./edit-file.js";
import { createFileInfoTool } from "./file-info.js";
import { getCurrentTimeTool } from "./get-current-time.js";
import { createGrepTool } from "./grep-files.js";
import { createListFilesTool } from "./list-files.js";
import { createMoveFileTool } from "./move-file.js";
import { createMultiEditTool } from "./multi-edit.js";
import { createReadFileTool } from "./read-file.js";
import { createReadLinesTool } from "./read-lines.js";
import { createReplaceLinesTool } from "./replace-lines.js";
import { createSearchFilesTool } from "./search-files.js";
import { createWriteFileTool } from "./write-file.js";

/**
 * Create all built-in file-operation tools. Path-tree visibility is the
 * `FilesApi`'s responsibility — the runtime hands tools a filtered view
 * (`FilteredFilesApi` or rebased `CompositeFilesApi`) where hidden paths
 * already reject writes and report as not-existing on reads.
 */
export function createFileTools(files: FilesApi): ToolSet {
  return {
    get_current_time: getCurrentTimeTool,
    read_file: createReadFileTool(files),
    read_lines: createReadLinesTool(files),
    write_file: createWriteFileTool(files),
    edit_file: createEditFileTool(files),
    multi_edit: createMultiEditTool(files),
    replace_lines: createReplaceLinesTool(files),
    delete_file: createDeleteFileTool(files),
    move_file: createMoveFileTool(files),
    list_files: createListFilesTool(files),
    search_files: createSearchFilesTool(files),
    grep: createGrepTool(files),
    file_info: createFileInfoTool(files),
    count_lines: createCountLinesTool(files),
    create_directory: createCreateDirectoryTool(files),
  };
}

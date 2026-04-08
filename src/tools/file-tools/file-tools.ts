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
import { createExcludedPathFilter } from "./path-utils.js";
import { createReadFileTool } from "./read-file.js";
import { createReadLinesTool } from "./read-lines.js";
import { createReplaceLinesTool } from "./replace-lines.js";
import { createSearchFilesTool } from "./search-files.js";
import { createWriteFileTool } from "./write-file.js";

export interface FileToolsOptions {
  excludedPrefixes: readonly string[];
}

/** Create all built-in file-operation tools. */
export function createFileTools(
  files: FilesApi,
  options: FileToolsOptions,
): ToolSet {
  const isExcluded = createExcludedPathFilter(options.excludedPrefixes);

  return {
    get_current_time: getCurrentTimeTool,
    read_file: createReadFileTool(files, isExcluded),
    read_lines: createReadLinesTool(files, isExcluded),
    write_file: createWriteFileTool(files, isExcluded),
    edit_file: createEditFileTool(files, isExcluded),
    multi_edit: createMultiEditTool(files, isExcluded),
    replace_lines: createReplaceLinesTool(files, isExcluded),
    delete_file: createDeleteFileTool(files, isExcluded),
    move_file: createMoveFileTool(files, isExcluded),
    list_files: createListFilesTool(files, isExcluded),
    search_files: createSearchFilesTool(files, isExcluded),
    grep: createGrepTool(files, isExcluded),
    file_info: createFileInfoTool(files, isExcluded),
    count_lines: createCountLinesTool(files, isExcluded),
    create_directory: createCreateDirectoryTool(files, isExcluded),
  };
}

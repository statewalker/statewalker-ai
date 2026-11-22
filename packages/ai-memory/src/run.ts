// One call of the memory service on one kind, the same for the memory tool and the memory API.
import { codedError } from "@statewalker/ai-access";
import type { MemoryCall } from "./calls.js";
import type { MemoryKind, Writer } from "./kinds.js";
import type { MemoryService } from "./service.js";

export function runMemoryCall(
  service: MemoryService,
  kind: MemoryKind,
  call: MemoryCall,
  writer: Writer,
): Promise<unknown> {
  switch (call.op) {
    case "list":
      return service.list(kind);
    case "entry":
      return service.entry(kind, String(call.id ?? ""));
    case "file":
      return service.file(kind, String(call.name ?? ""));
    case "batch":
      return service.batch(kind, call.actions ?? [], writer);
    case "erase":
      if (call.id === undefined && call.name === undefined)
        throw codedError("EINVAL", "erase names an entry (id) or an attachment (name)");
      return service.erase(kind, call.id !== undefined ? { id: call.id } : { name: call.name });
    default:
      throw codedError("EINVAL", `no memory op '${call.op}' on one kind`);
  }
}

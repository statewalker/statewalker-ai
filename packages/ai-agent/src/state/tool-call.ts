import type { JSONValue } from "ai";
import { NodeType } from "./node-types.js";
import { TreeNode } from "./tree-node.js";

export class ToolCall extends TreeNode {
  get callId(): string {
    return this.props.callId as string;
  }

  get toolName(): string {
    return this.props.toolName as string;
  }

  get request(): TreeNode | undefined {
    return this.childrenOfType(NodeType.toolRequest)[0];
  }

  get response(): TreeNode | undefined {
    return this.childrenOfType(NodeType.toolResponse)[0];
  }

  get args(): unknown {
    return this.request?.props.args;
  }

  get result(): string | undefined {
    return this.response?.content;
  }

  get isError(): boolean {
    return (this.response?.props.isError as boolean) ?? false;
  }

  get progressText(): string | undefined {
    return this.props.progressText as string | undefined;
  }

  set progressText(text: string | undefined) {
    this.props.progressText = text;
    this.touch();
  }

  addResponse(text: string, isError = false): TreeNode {
    return this.addChild({
      type: NodeType.toolResponse,
      content: text,
      props: { callId: this.callId, toolName: this.toolName, isError },
    });
  }

  appendUpdate(text: string): void {
    const resp = this.response;
    if (resp) {
      resp.content = text;
      resp.touch();
    }
  }

  /** Build assistant tool-call content part. */
  toAssistantPart(): Record<string, unknown> {
    const part: Record<string, unknown> = {
      type: "tool-call",
      toolCallId: this.callId,
      toolName: this.toolName,
      input: (this.args as Record<string, unknown>) ?? {},
    };
    if (this.props.providerMetadata) {
      part.providerOptions = this.props.providerMetadata;
    }
    return part;
  }

  /** Build a tool-role ModelMessage for the tool result. */
  toResultMessage():
    | {
        role: "tool";
        content: Array<{
          type: "tool-result";
          toolCallId: string;
          toolName: string;
          output: { type: "json"; value: JSONValue };
        }>;
      }
    | undefined {
    if (!this.response) return undefined;
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: this.callId,
          toolName: this.toolName,
          output: {
            type: "json",
            value: (this.result ?? null) as JSONValue,
          },
        },
      ],
    };
  }
}

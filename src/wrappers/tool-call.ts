import { createEntry } from "../create-entry.js";
import { NodeType } from "../node-types.js";
import { TreeNode } from "../tree-node.js";

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
    this.notify();
  }

  addResponse(text: string, isError = false): TreeNode {
    const entry = createEntry({
      type: NodeType.toolResponse,
      content: text,
      props: { callId: this.callId, toolName: this.toolName, isError },
    });
    return this.addChild(entry);
  }

  appendUpdate(text: string): void {
    const resp = this.response;
    if (resp) {
      resp.content = text;
      resp.touch();
    }
  }
}

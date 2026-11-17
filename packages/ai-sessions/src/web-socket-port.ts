// A WebSocket as a webrun-rpc MessageTarget: each message is one JSON text frame. Its close
// signal aborts when the socket closes, so calls in flight fail instead of waiting.
import type { MessageListener, MessageTarget } from "@statewalker/webrun-rpc";

/** The part of a WebSocket (browser, Workers, Node's `ws`) the port uses. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
}

export function webSocketPort(ws: WebSocketLike): MessageTarget {
  const listeners = new Set<MessageListener>();
  const closed = new AbortController();
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    for (const listener of listeners) void listener({ data } as MessageEvent);
  });
  const onClose = () => closed.abort(new Error("EIO: the connection closed"));
  ws.addEventListener("close", onClose);
  ws.addEventListener("error", onClose);
  return {
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
    postMessage: (message) => ws.send(JSON.stringify(message)),
    close: () => ws.close(1000),
    closeSignal: closed.signal,
  };
}

export const readSSE = async (res: Response): Promise<{ chunks: unknown[]; sawDone: boolean }> => {
  if (!res.body) throw new Error("Response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const chunks: unknown[] = [];
  let sawDone = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const event of events) {
      const data = event
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice("data: ".length))
        .join("");
      if (!data) continue;
      if (data === "[DONE]") {
        sawDone = true;
        continue;
      }
      chunks.push(JSON.parse(data));
    }
  }
  if (buf.trim()) {
    const data = buf
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice("data: ".length))
      .join("");
    if (data === "[DONE]") sawDone = true;
    else if (data) chunks.push(JSON.parse(data));
  }
  return { chunks, sawDone };
};

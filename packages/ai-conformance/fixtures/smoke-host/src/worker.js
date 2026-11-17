// Smoke host for the conformance runner (see wrangler.jsonc).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/runtime") return Response.json({ harness: "statewalker-ai" });
    if (url.pathname === "/v1/runtime/model" && request.method === "POST") {
      const res = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "scripted",
          messages: [{ role: "user", content: await request.text() }],
        }),
      });
      const reply = await res.json();
      return Response.json({ text: reply.choices[0].message.content });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};

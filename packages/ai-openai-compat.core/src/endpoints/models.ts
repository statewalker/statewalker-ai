import type { Init } from "../index.js";

export interface ModelListItem {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface ModelList {
  object: "list";
  data: ModelListItem[];
}

export const handleModels = (init: Init): Response => {
  const ids = new Set<string>([
    ...Object.keys(init.languageModels ?? {}),
    ...Object.keys(init.embeddingModels ?? {}),
  ]);
  const created = Math.floor(Date.now() / 1000);
  const body: ModelList = {
    object: "list",
    data: Array.from(ids).map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "openai-compat",
    })),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

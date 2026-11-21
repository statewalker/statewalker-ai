// A fake S3 endpoint for scenarios with an S3-backed workspace: the subset of the S3 REST API
// webrun-files-s3 uses (path-style buckets; Get, Head, Put, Delete, Copy, ListObjectsV2, and
// multipart uploads), with objects in memory. It checks no signature.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeS3 {
  /** The endpoint URL (path-style). */
  url: string;
  /** The object keys of a bucket. */
  keys(bucket: string): string[];
  close(): Promise<void>;
}

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

export async function fakeS3(): Promise<FakeS3> {
  const buckets = new Map<string, Map<string, { data: Buffer; mtime: Date }>>();
  const uploads = new Map<string, Map<number, Buffer>>();
  const bucketOf = (name: string) => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    return buckets.get(name) as Map<string, { data: Buffer; mtime: Date }>;
  };
  const etag = (data: Buffer) =>
    `"${data.length.toString(16)}-${data.subarray(0, 8).toString("hex")}"`;
  const fail = (res: ServerResponse, status: number, code: string) => {
    res.writeHead(status, { "content-type": "application/xml" });
    res.end(xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`));
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const [, bucketName = "", ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      const bucket = bucketOf(bucketName);
      const q = url.searchParams;
      const method = req.method ?? "GET";
      if (method === "GET" && !key && q.get("list-type") === "2") {
        const prefix = q.get("prefix") ?? "";
        const delimiter = q.get("delimiter") ?? "";
        const max = Number(q.get("max-keys") ?? 1000);
        const after = q.get("continuation-token") ?? q.get("start-after") ?? "";
        const sorted = [...bucket.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const contents: string[] = [];
        const prefixes = new Set<string>();
        let last = "";
        let truncated = false;
        for (const k of sorted) {
          if (contents.length + prefixes.size >= max) {
            truncated = true;
            break;
          }
          const tail = k.slice(prefix.length);
          const cut = delimiter ? tail.indexOf(delimiter) : -1;
          if (cut >= 0) {
            const p = prefix + tail.slice(0, cut + delimiter.length);
            if (!prefixes.has(p)) prefixes.add(p);
            last = k;
            continue;
          }
          const o = bucket.get(k) as { data: Buffer; mtime: Date };
          contents.push(
            `<Contents><Key>${esc(k)}</Key><Size>${o.data.length}</Size><LastModified>${o.mtime.toISOString()}</LastModified><ETag>${etag(o.data)}</ETag></Contents>`,
          );
          last = k;
        }
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(
          xml(
            `<ListBucketResult><Name>${esc(bucketName)}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${contents.length + prefixes.size}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${esc(last)}</NextContinuationToken>` : ""}${contents.join("")}${[...prefixes].map((p) => `<CommonPrefixes><Prefix>${esc(p)}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`,
          ),
        );
        return;
      }
      if (method === "POST" && q.has("uploads")) {
        const id = crypto.randomUUID();
        uploads.set(id, new Map());
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(
          xml(
            `<InitiateMultipartUploadResult><Bucket>${esc(bucketName)}</Bucket><Key>${esc(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
          ),
        );
        return;
      }
      if (method === "PUT" && q.has("uploadId")) {
        const parts = uploads.get(q.get("uploadId") ?? "");
        if (!parts) return fail(res, 404, "NoSuchUpload");
        const data = await bodyOf(req);
        parts.set(Number(q.get("partNumber")), data);
        res.writeHead(200, { etag: etag(data) });
        res.end();
        return;
      }
      if (method === "POST" && q.has("uploadId")) {
        const id = q.get("uploadId") ?? "";
        const parts = uploads.get(id);
        if (!parts) return fail(res, 404, "NoSuchUpload");
        await bodyOf(req);
        const data = Buffer.concat(
          [...parts.entries()].sort((a, b) => a[0] - b[0]).map((p) => p[1]),
        );
        uploads.delete(id);
        if (req.headers["if-none-match"] === "*" && bucket.has(key))
          return fail(res, 412, "PreconditionFailed");
        bucket.set(key, { data, mtime: new Date() });
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(
          xml(
            `<CompleteMultipartUploadResult><Bucket>${esc(bucketName)}</Bucket><Key>${esc(key)}</Key><ETag>${etag(data)}</ETag></CompleteMultipartUploadResult>`,
          ),
        );
        return;
      }
      if (method === "DELETE" && q.has("uploadId")) {
        uploads.delete(q.get("uploadId") ?? "");
        res.writeHead(204);
        res.end();
        return;
      }
      if (method === "PUT" && req.headers["x-amz-copy-source"]) {
        const source = decodeURIComponent(String(req.headers["x-amz-copy-source"])).replace(
          /^\//,
          "",
        );
        const [srcBucket = "", ...srcKey] = source.split("/");
        const o = bucketOf(srcBucket).get(srcKey.join("/"));
        if (!o) return fail(res, 404, "NoSuchKey");
        bucket.set(key, { data: o.data, mtime: new Date() });
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(
          xml(
            `<CopyObjectResult><ETag>${etag(o.data)}</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyObjectResult>`,
          ),
        );
        return;
      }
      if (method === "PUT") {
        const data = await bodyOf(req);
        if (req.headers["if-none-match"] === "*" && bucket.has(key))
          return fail(res, 412, "PreconditionFailed");
        bucket.set(key, { data, mtime: new Date() });
        res.writeHead(200, { etag: etag(data) });
        res.end();
        return;
      }
      if (method === "DELETE") {
        bucket.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      if (method === "GET" || method === "HEAD") {
        const o = bucket.get(key);
        if (!o) {
          if (method === "HEAD") {
            res.writeHead(404);
            res.end();
            return;
          }
          return fail(res, 404, "NoSuchKey");
        }
        let data = o.data;
        let status = 200;
        const headers: Record<string, string> = {
          "last-modified": o.mtime.toUTCString(),
          etag: etag(o.data),
          "content-type": "application/octet-stream",
        };
        const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
        if (range) {
          const start = Number(range[1]);
          if (start >= o.data.length && o.data.length > 0) return fail(res, 416, "InvalidRange");
          const end = range[2] ? Math.min(Number(range[2]), o.data.length - 1) : o.data.length - 1;
          data = o.data.subarray(start, end + 1);
          status = 206;
          headers["content-range"] = `bytes ${start}-${end}/${o.data.length}`;
        }
        headers["content-length"] = String(data.length);
        res.writeHead(status, headers);
        res.end(method === "HEAD" ? undefined : data);
        return;
      }
      fail(res, 400, "NotImplemented");
    } catch (e) {
      fail(res, 500, `InternalError ${String(e)}`);
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    keys: (bucket) => [...bucketOf(bucket).keys()].sort(),
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

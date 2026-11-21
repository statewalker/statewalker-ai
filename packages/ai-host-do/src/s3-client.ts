// The S3 client of the S3 workspace backend: the `send(command)` webrun-files-s3 needs, answered
// with fetch and SigV4 (aws4fetch) for the commands it sends. The AWS SDK's own client cannot be
// constructed in a bundle resolved with workerd's conditions alone (CellB's): its Node runtime
// config is bundled while its core resolves to the browser build. The commands still come from
// the SDK, so `input` is exactly what webrun-files-s3 builds.
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { AwsClient } from "aws4fetch";

export interface S3ClientOptions {
  region: string;
  /** An S3-compatible endpoint (path-style); AWS's regional endpoint when absent. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

type Input = Record<string, unknown>;

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const escXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1] as string) : undefined;
};
const blocks = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1] as string);

async function* bodyOf(res: Response): AsyncIterable<Uint8Array> {
  if (!res.body) return;
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    yield value;
  }
}

export class FetchS3Client {
  readonly #aws: AwsClient;
  readonly #endpoint: string;

  constructor(options: S3ClientOptions) {
    this.#aws = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: options.region,
      service: "s3",
    });
    this.#endpoint = (options.endpoint ?? `https://s3.${options.region}.amazonaws.com`).replace(
      /\/+$/,
      "",
    );
  }

  #url(input: Input, query: Record<string, string | undefined> = {}): string {
    const key = String(input.Key ?? "")
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const url = new URL(`${this.#endpoint}/${encodeURIComponent(String(input.Bucket))}/${key}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    return url.toString();
  }

  async #fetch(
    method: string,
    url: string,
    init: { headers?: Record<string, string>; body?: BodyInit } = {},
  ) {
    const res = await this.#aws.fetch(url, { method, headers: init.headers, body: init.body });
    if (res.ok) return res;
    const text = method === "HEAD" ? "" : await res.text().catch(() => "");
    const code = tag(text, "Code") ?? (res.status === 404 ? "NotFound" : `Http${res.status}`);
    throw Object.assign(new Error(`${code}: ${tag(text, "Message") ?? res.statusText}`), {
      name: code,
      $metadata: { httpStatusCode: res.status },
    });
  }

  async send(command: { input: unknown }): Promise<Record<string, unknown>> {
    const input = command.input as Input;
    const ifNoneMatch: Record<string, string> = input.IfNoneMatch
      ? { "if-none-match": String(input.IfNoneMatch) }
      : {};
    if (command instanceof GetObjectCommand) {
      const range = input.Range ? { range: String(input.Range) } : undefined;
      const res = await this.#fetch("GET", this.#url(input), { headers: range });
      return {
        Body: bodyOf(res),
        ContentLength: Number(res.headers.get("content-length") ?? 0),
        LastModified: new Date(res.headers.get("last-modified") ?? 0),
      };
    }
    if (command instanceof HeadObjectCommand) {
      const res = await this.#fetch("HEAD", this.#url(input));
      return {
        ContentLength: Number(res.headers.get("content-length") ?? 0),
        LastModified: new Date(res.headers.get("last-modified") ?? 0),
      };
    }
    if (command instanceof PutObjectCommand) {
      const res = await this.#fetch("PUT", this.#url(input), {
        headers: ifNoneMatch,
        body: input.Body as BodyInit,
      });
      return { ETag: res.headers.get("etag") ?? undefined };
    }
    if (command instanceof DeleteObjectCommand) {
      await this.#fetch("DELETE", this.#url(input));
      return {};
    }
    if (command instanceof CopyObjectCommand) {
      await this.#fetch("PUT", this.#url(input), {
        headers: { "x-amz-copy-source": String(input.CopySource) },
      });
      return {};
    }
    if (command instanceof ListObjectsV2Command) {
      const res = await this.#fetch(
        "GET",
        this.#url(
          { Bucket: input.Bucket },
          {
            "list-type": "2",
            prefix: input.Prefix as string | undefined,
            delimiter: input.Delimiter as string | undefined,
            "continuation-token": input.ContinuationToken as string | undefined,
            "start-after": input.StartAfter as string | undefined,
            "max-keys": input.MaxKeys === undefined ? undefined : String(input.MaxKeys),
          },
        ),
      );
      const xml = await res.text();
      return {
        Contents: blocks(xml, "Contents").map((c) => ({
          Key: tag(c, "Key"),
          Size: Number(tag(c, "Size") ?? 0),
          LastModified: new Date(tag(c, "LastModified") ?? 0),
          ETag: tag(c, "ETag"),
        })),
        CommonPrefixes: blocks(xml, "CommonPrefixes").map((c) => ({ Prefix: tag(c, "Prefix") })),
        IsTruncated: tag(xml, "IsTruncated") === "true",
        NextContinuationToken: tag(xml, "NextContinuationToken"),
      };
    }
    if (command instanceof CreateMultipartUploadCommand) {
      const res = await this.#fetch("POST", this.#url(input, { uploads: "" }));
      return { UploadId: tag(await res.text(), "UploadId") };
    }
    if (command instanceof UploadPartCommand) {
      const res = await this.#fetch(
        "PUT",
        this.#url(input, {
          partNumber: String(input.PartNumber),
          uploadId: String(input.UploadId),
        }),
        { body: input.Body as BodyInit },
      );
      return { ETag: res.headers.get("etag") ?? undefined };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const parts = ((input.MultipartUpload as { Parts?: Input[] })?.Parts ?? [])
        .map(
          (p) =>
            `<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${escXml(String(p.ETag))}</ETag></Part>`,
        )
        .join("");
      const res = await this.#fetch(
        "POST",
        this.#url(input, { uploadId: String(input.UploadId) }),
        {
          headers: ifNoneMatch,
          body: `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`,
        },
      );
      const xml = await res.text();
      // S3 may answer 200 with an error document.
      if (xml.includes("<Error>"))
        throw Object.assign(new Error(tag(xml, "Code") ?? "InternalError"), {
          name: tag(xml, "Code") ?? "InternalError",
          $metadata: { httpStatusCode: 500 },
        });
      return { ETag: tag(xml, "ETag") };
    }
    if (command instanceof AbortMultipartUploadCommand) {
      await this.#fetch("DELETE", this.#url(input, { uploadId: String(input.UploadId) }));
      return {};
    }
    throw new Error(`ENOSYS: S3 command ${(command as object).constructor.name}`);
  }
}

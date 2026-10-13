import { resolvePrivateRuntimeContentUrl } from "./runtimeContentDelivery";

export type VerifiedByteMember = {
  file_ref: string;
  url: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
};

export type VerifiedByte = {
  member: VerifiedByteMember;
  blob: Blob;
};

export type VerifiedByteFailureCode =
  | "request_failed"
  | "size_mismatch"
  | "digest_mismatch"
  | "member_too_large";

export class VerifiedByteError extends Error {
  readonly code: VerifiedByteFailureCode;

  constructor(code: VerifiedByteFailureCode, message: string) {
    super(message);
    this.code = code;
    this.name = "VerifiedByteError";
  }
}

type VerifiedByteLoaderOptions = {
  fetcher?: typeof fetch;
  apiBaseUrl?: string;
  maxMemberBytes?: number;
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", view as ArrayBuffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Runtime preparation cancelled.", "AbortError");
  }
}

async function readExactBytes(
  response: Response,
  expectedBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) !== expectedBytes) {
    throw new VerifiedByteError(
      "size_mismatch",
      "Runtime content size no longer matches its descriptor.",
    );
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== expectedBytes) {
      throw new VerifiedByteError(
        "size_mismatch",
        "Runtime content size no longer matches its descriptor.",
      );
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > expectedBytes) {
      await reader.cancel("Runtime content exceeded its expected size.");
      throw new VerifiedByteError(
        "size_mismatch",
        "Runtime content size no longer matches its descriptor.",
      );
    }
    chunks.push(value);
  }
  if (received !== expectedBytes) {
    throw new VerifiedByteError(
      "size_mismatch",
      "Runtime content size no longer matches its descriptor.",
    );
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Shared exact-byte admission for individual responses and bundled JSON text. */
export async function verifyRuntimeBytes(
  member: VerifiedByteMember,
  bytes: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<VerifiedByte> {
  throwIfAborted(signal);
  if (bytes.byteLength !== member.size_bytes) {
    throw new VerifiedByteError(
      "size_mismatch",
      "Runtime content size no longer matches its descriptor.",
    );
  }
  if ((await sha256Hex(bytes)) !== member.sha256) {
    throw new VerifiedByteError(
      "digest_mismatch",
      "Runtime content digest changed and no longer matches its descriptor.",
    );
  }
  throwIfAborted(signal);
  return {
    member,
    // Blob copies just the view's bytes; an extra slice would briefly double a model.
    blob: new Blob([bytes], { type: member.media_type }),
  };
}

/** Fetch and verify exact runtime bytes, deduplicating concurrent requests. */
export class VerifiedByteLoader {
  private readonly fetcher: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly maxMemberBytes: number;
  private readonly inFlight = new Map<string, Promise<VerifiedByte>>();

  constructor(options: VerifiedByteLoaderOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.apiBaseUrl =
      options.apiBaseUrl ??
      (typeof window !== "undefined" ? window.location.origin : "");
    this.maxMemberBytes = options.maxMemberBytes ?? 1024 * 1024 * 1024;
  }

  load(
    member: VerifiedByteMember,
    signal?: AbortSignal,
  ): Promise<VerifiedByte> {
    const key = `${member.file_ref}:${member.sha256}`;
    const active = this.inFlight.get(key);
    if (active) return active;
    const pending = this.fetchAndVerify(member, signal).finally(() => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  private async fetchAndVerify(
    member: VerifiedByteMember,
    signal?: AbortSignal,
  ): Promise<VerifiedByte> {
    if (member.size_bytes <= 0 || member.size_bytes > this.maxMemberBytes) {
      throw new VerifiedByteError(
        "member_too_large",
        "Runtime content exceeds the per-file memory limit.",
      );
    }
    throwIfAborted(signal);
    const url = this.apiBaseUrl
      ? resolvePrivateRuntimeContentUrl(member.url, this.apiBaseUrl)
      : member.url;
    const response = await this.fetcher(url, {
      cache: "no-cache",
      credentials: "same-origin",
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      throw new VerifiedByteError(
        "request_failed",
        `Runtime content request failed with HTTP ${response.status}.`,
      );
    }
    throwIfAborted(signal);
    const bytes = await readExactBytes(response, member.size_bytes);
    throwIfAborted(signal);
    return verifyRuntimeBytes(member, bytes, signal);
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DraftCheckReport,
  DraftChecksWorkerRequest,
  DraftChecksWorkerResponse,
} from "./draftChecks";
import { createDraftChecksClient } from "./draftChecksClient";
import type { IncludedAvatarId } from "./headlessVrm";

/** The report the fake worker returns for a clip: it echoes the clip's id. */
const reportFor = (clip: unknown): DraftCheckReport => ({
  ok: true,
  loadable: true,
  issues: [{ path: "id", message: String((clip as { id?: unknown }).id) }],
  findings: [],
});

const fixture = {
  workers: [] as FakeWorker[],
  /** Requests stay unanswered, as while a long check runs. */
  holdReplies: false,
  /** The worker answers `load` with a failure. */
  failLoad: false,
};

/** Answers like `workers/draft-checks-worker.ts` until it is terminated. */
class FakeWorker {
  terminated = false;
  requests: DraftChecksWorkerRequest[] = [];
  transfers: unknown[] = [];
  /** Ids of the Avatars the worker has parsed. */
  loadedAvatars: string[] = [];
  private listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor() {
    fixture.workers.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  postMessage(request: DraftChecksWorkerRequest, transfer?: unknown) {
    this.requests.push(request);
    this.transfers.push(transfer);
    if (this.terminated || fixture.holdReplies) return;
    queueMicrotask(() => this.reply(this.answer(request)));
  }
  private answer(request: DraftChecksWorkerRequest): DraftChecksWorkerResponse {
    const { requestId } = request;
    if (request.type === "load") {
      if (fixture.failLoad)
        return { type: "failed", requestId, message: "not a VRM" };
      this.loadedAvatars = request.avatars.map(({ id }) => id);
      return { type: "loaded", requestId };
    }
    return (request.clip as { id?: unknown }).id === "explode"
      ? { type: "failed", requestId, message: "the check threw" }
      : { type: "checked", requestId, report: reportFor(request.clip) };
  }
  reply(response: DraftChecksWorkerResponse) {
    if (!this.terminated) this.emit("message", { data: response });
  }
  terminate() {
    this.terminated = true;
  }
  emit(type: string, event: unknown) {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

/** One buffer per Included Avatar, with the calls that asked for it. */
function avatarFiles() {
  const buffers: Record<string, ArrayBuffer> = {
    Andrew: new ArrayBuffer(8),
    Annie: new ArrayBuffer(16),
  };
  const bytes = vi.fn(async (id: IncludedAvatarId) => buffers[id]);
  return { buffers, bytes };
}

beforeEach(() => {
  vi.stubGlobal("Worker", FakeWorker);
  fixture.workers = [];
  fixture.holdReplies = false;
  fixture.failLoad = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createDraftChecksClient", () => {
  it("starts no worker and reads no Avatar until the first check", () => {
    const { bytes } = avatarFiles();
    createDraftChecksClient(bytes);
    expect(fixture.workers).toHaveLength(0);
    expect(bytes).not.toHaveBeenCalled();
  });

  it("loads both Included Avatars once, then checks each clip", async () => {
    const { buffers, bytes } = avatarFiles();
    const client = createDraftChecksClient(bytes);

    await expect(client.check({ id: "first" })).resolves.toEqual(
      reportFor({ id: "first" }),
    );
    await expect(client.check({ id: "second" })).resolves.toEqual(
      reportFor({ id: "second" }),
    );

    expect(fixture.workers).toHaveLength(1);
    const [worker] = fixture.workers;
    expect(worker.requests.map(({ type }) => type)).toEqual([
      "load",
      "check",
      "check",
    ]);
    expect(worker.loadedAvatars).toEqual(["Andrew", "Annie"]);
    expect(bytes.mock.calls).toEqual([["Andrew"], ["Annie"]]);
    // The files are copied to the worker: the caller's buffers stay usable.
    expect(worker.transfers).toEqual([undefined, undefined, undefined]);
    expect(buffers.Andrew.byteLength).toBe(8);
    client.dispose();
  });

  it("answers checks made together, each with its own report", async () => {
    const client = createDraftChecksClient(avatarFiles().bytes);
    const reports = await Promise.all(
      ["a", "b", "c"].map((id) => client.check({ id })),
    );
    expect(reports).toEqual(["a", "b", "c"].map((id) => reportFor({ id })));
    expect(
      fixture.workers[0].requests.filter(({ type }) => type === "load"),
    ).toHaveLength(1);
    client.dispose();
  });

  it("rejects a check the worker could not run and keeps working", async () => {
    const client = createDraftChecksClient(avatarFiles().bytes);
    await expect(client.check({ id: "explode" })).rejects.toThrow(
      "the check threw",
    );
    await expect(client.check({ id: "next" })).resolves.toBeDefined();
    expect(fixture.workers).toHaveLength(1);
    client.dispose();
  });

  it("rejects a clip that cannot be sent to the worker", async () => {
    const client = createDraftChecksClient(avatarFiles().bytes);
    await client.check({ id: "first" });
    vi.spyOn(fixture.workers[0], "postMessage").mockImplementationOnce(() => {
      throw new DOMException("could not be cloned", "DataCloneError");
    });
    await expect(client.check({ id: () => "function" })).rejects.toThrow(
      "could not be cloned",
    );
    await expect(client.check({ id: "next" })).resolves.toBeDefined();
    client.dispose();
  });

  it("reads the Avatars again after they failed to load", async () => {
    const { bytes } = avatarFiles();
    const client = createDraftChecksClient(bytes);

    bytes.mockRejectedValueOnce(new Error("offline"));
    await expect(client.check({ id: "first" })).rejects.toThrow("offline");

    fixture.failLoad = true;
    await expect(client.check({ id: "second" })).rejects.toThrow("not a VRM");

    fixture.failLoad = false;
    await expect(client.check({ id: "third" })).resolves.toEqual(
      reportFor({ id: "third" }),
    );
    client.dispose();
  });

  it("fails the checks in flight when the worker errors, then starts a new worker", async () => {
    const { bytes } = avatarFiles();
    const client = createDraftChecksClient(bytes);
    await client.check({ id: "first" });

    fixture.holdReplies = true;
    const checking = client.check({ id: "second" });
    await vi.waitFor(() => expect(fixture.workers[0].requests).toHaveLength(3));
    fixture.workers[0].emit("error", { message: "worker script failed" });
    await expect(checking).rejects.toThrow("worker");
    expect(fixture.workers[0].terminated).toBe(true);

    fixture.holdReplies = false;
    await expect(client.check({ id: "third" })).resolves.toEqual(
      reportFor({ id: "third" }),
    );
    expect(fixture.workers).toHaveLength(2);
    // The new worker has no Avatars until they are loaded again.
    expect(fixture.workers[1].loadedAvatars).toEqual(["Andrew", "Annie"]);
    expect(bytes).toHaveBeenCalledTimes(4);
    client.dispose();
  });

  it("stops the worker on dispose and refuses later checks", async () => {
    const client = createDraftChecksClient(avatarFiles().bytes);
    await client.check({ id: "first" });

    fixture.holdReplies = true;
    const checking = client.check({ id: "second" });
    client.dispose();
    await expect(checking).rejects.toThrow("disposed");
    expect(fixture.workers[0].terminated).toBe(true);

    fixture.holdReplies = false;
    await expect(client.check({ id: "third" })).rejects.toThrow("disposed");
    expect(fixture.workers).toHaveLength(1);
    // Disposing twice, or a client that never checked, is harmless.
    client.dispose();
    createDraftChecksClient(avatarFiles().bytes).dispose();
  });

  it("drops a check that was waiting for the Avatars when it is disposed", async () => {
    const { bytes } = avatarFiles();
    let release: (buffer: ArrayBuffer) => void = () => undefined;
    bytes.mockImplementationOnce(
      () => new Promise<ArrayBuffer>((resolve) => (release = resolve)),
    );
    const client = createDraftChecksClient(bytes);
    const checking = client.check({ id: "first" });
    client.dispose();
    release(new ArrayBuffer(8));
    await expect(checking).rejects.toThrow("disposed");
    expect(fixture.workers[0].requests).toEqual([]);
  });

  it("rejects where the browser has no workers", async () => {
    vi.stubGlobal("Worker", undefined);
    await expect(
      createDraftChecksClient(avatarFiles().bytes).check({ id: "first" }),
    ).rejects.toThrow("Web Workers");
  });
});

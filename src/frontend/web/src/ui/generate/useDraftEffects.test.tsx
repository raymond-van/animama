// @vitest-environment happy-dom
import type { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import { privateStateResets } from "@/app/runtime/private-module-state";
import { createEffectLibraryServer } from "./testing/effectLibraryServer";
import {
  effectGestureProject,
  generationDraft,
  gestureProject,
  sparkleDependency,
  waveHelloClip,
} from "./testing/generationFixtures";
import {
  mountGenerationHook,
  settle,
  type MountedHook,
} from "./testing/generationHarness";
import { useDraftEffects, type DraftEffectsView } from "./useDraftEffects";

let library = createEffectLibraryServer();

async function fetch(request: Request): Promise<Response> {
  const answer = await library.handle(request);
  if (!answer)
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  return answer;
}

type Props = {
  drafts: readonly PyGenerationDraft[];
  selected: PyGenerationDraft | null;
};
let mounted: MountedHook<Props, DraftEffectsView> | null = null;

function mount(props: Props, queryClient?: QueryClient) {
  mounted = mountGenerationHook(
    ({ drafts, selected }: Props) => useDraftEffects(drafts, selected),
    { props, fetch, queryClient },
  );
  return mounted;
}

const plain = generationDraft({ id: "plain-1", status: "ready" });
const plainToo = generationDraft({
  id: "plain-2",
  position: 1,
  status: "ready",
  project: gestureProject({ name: "Deep Bow" }),
});
const sparkling = generationDraft({
  id: "sparkling",
  position: 2,
  status: "ready",
  project: effectGestureProject(),
});
/** A draft that plays a Particle Effect of its own. */
const raining = generationDraft({
  id: "raining",
  position: 3,
  status: "ready",
  project: gestureProject({
    name: "Rain Dance",
    sequence: {
      ...waveHelloClip(),
      events: [
        { id: "rain-1", time: 0.2, kind: "particle_vfx", effectId: "rain" },
      ],
    },
    dependencies: [
      {
        alias: "rain",
        content_type: "particle_effect",
        source: { type: "catalog", catalog_item_id: "effect-item-2" },
      },
    ],
  }),
});

beforeEach(() => {
  library = createEffectLibraryServer();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  for (const reset of privateStateResets()) reset();
});

describe("useDraftEffects", () => {
  it("asks nothing and keeps one empty list while the selection moves between drafts without effects", async () => {
    const drafts = [plain, plainToo];
    const hook = mount({ drafts, selected: plain });
    await settle();
    const entries = hook.result().sandboxEntries;
    expect(entries).toEqual([]);

    for (const selected of [plainToo, null, plain]) {
      hook.rerender({ drafts, selected });
      await settle();
      // The same list: the preview keeps its catalog, and so its Avatar.
      expect(hook.result().sandboxEntries).toBe(entries);
    }
    expect(hook.result().byDraft.size).toBe(0);
    expect(library.requests).toEqual([]);
  });

  it("mounts the selected draft's effects as the creator's sandbox entries, under their aliases", async () => {
    const drafts = [plain, sparkling];
    const hook = mount({ drafts, selected: sparkling });
    expect(hook.result().sandboxEntries).toEqual([]);
    await settle();

    expect(hook.result().sandboxEntries).toMatchObject([
      { slot: "avatar_vfx", runtime_id: sparkleDependency().alias },
    ]);
    expect(hook.result().byDraft).toEqual(
      new Map([["sparkling", { aliases: ["sparkle"], missing: [] }]]),
    );
    // The selection and the list name the same items: one request serves both.
    expect(library.requests).toEqual([["effect-item-1"]]);
  });

  it("keeps the entries while the selected draft's effects stay as they are", async () => {
    const hook = mount({ drafts: [sparkling], selected: sparkling });
    await settle();
    const entries = hook.result().sandboxEntries;
    expect(entries).toHaveLength(1);

    // A status update: a new draft object around the same project.
    const settled = { ...sparkling, status: "warnings" as const };
    hook.rerender({ drafts: [settled], selected: settled });
    await settle();
    expect(hook.result().sandboxEntries).toBe(entries);

    // A new version that plays the same effect.
    const revised = {
      ...sparkling,
      version: 2,
      project: effectGestureProject({ name: "Shyer Wave" }),
    };
    hook.rerender({ drafts: [revised], selected: revised });
    await settle();
    expect(hook.result().sandboxEntries).toBe(entries);
    expect(library.requests).toHaveLength(1);
  });

  it("unmounts the effects when the selection moves to a draft without any", async () => {
    const drafts = [plain, sparkling];
    const hook = mount({ drafts, selected: sparkling });
    await settle();
    expect(hook.result().sandboxEntries).toHaveLength(1);

    hook.rerender({ drafts, selected: plain });
    await settle();
    expect(hook.result().sandboxEntries).toEqual([]);
    // The list still knows what the other draft plays.
    expect(hook.result().byDraft.get("sparkling")).toEqual({
      aliases: ["sparkle"],
      missing: [],
    });
  });

  it("learns in one request which listed drafts play an effect the Library no longer holds", async () => {
    library.gone.add("effect-item-2");
    const drafts = [plain, sparkling, raining];
    const hook = mount({ drafts, selected: sparkling });
    await settle();

    expect(hook.result().byDraft).toEqual(
      new Map([
        ["sparkling", { aliases: ["sparkle"], missing: [] }],
        ["raining", { aliases: ["rain"], missing: ["rain"] }],
      ]),
    );
    // One request for the selection's preview, one for every listed draft.
    expect(library.requests.toSorted()).toEqual([
      ["effect-item-1"],
      ["effect-item-1", "effect-item-2"],
    ]);
    // The selected draft still plays its own effect.
    expect(hook.result().sandboxEntries).toMatchObject([
      { runtime_id: "sparkle" },
    ]);
  });

  it("asks the Library again when the page is opened again, so a deletion made meanwhile shows", async () => {
    const drafts = [plain, raining];
    const first = mount({ drafts, selected: plain });
    await settle();
    expect(first.result().byDraft.get("raining")!.missing).toEqual([]);
    const { queryClient } = first;
    first.unmount();

    // The effect is deleted in the Library, and the page is opened again
    // while the earlier answer is still cached.
    library.gone.add("effect-item-2");
    const again = mount({ drafts, selected: plain }, queryClient);
    await settle();
    expect(again.result().byDraft.get("raining")).toEqual({
      aliases: ["rain"],
      missing: ["rain"],
    });
    expect(library.requests).toEqual([["effect-item-2"], ["effect-item-2"]]);
  });

  it("says so for the selected draft too, and mounts nothing for an effect that is gone", async () => {
    library.gone.add("effect-item-1");
    const hook = mount({ drafts: [sparkling], selected: sparkling });
    await settle();
    expect(hook.result().byDraft.get("sparkling")).toEqual({
      aliases: ["sparkle"],
      missing: ["sparkle"],
    });
    expect(hook.result().sandboxEntries).toEqual([]);
  });

  it("calls no effect missing while it is being checked, or when it could not be checked", async () => {
    library.down = true;
    const hook = mount({ drafts: [sparkling, raining], selected: sparkling });
    // The requests are still in flight.
    expect(hook.result().byDraft.get("raining")!.missing).toEqual([]);
    await settle();
    expect(library.requests.length).toBeGreaterThan(0);
    for (const id of ["sparkling", "raining"])
      expect(hook.result().byDraft.get(id)!.missing).toEqual([]);
  });

  it("calls no effect missing that is still in the Library but cannot be shown", async () => {
    library.unshown.set("effect-item-2", "source_scan_required");
    const hook = mount({ drafts: [raining], selected: null });
    await settle();
    expect(library.requests).toEqual([["effect-item-2"]]);
    expect(hook.result().byDraft.get("raining")).toEqual({
      aliases: ["rain"],
      missing: [],
    });
  });

  it("names an alias the draft never pinned without asking the Library", async () => {
    const unpinned = generationDraft({
      id: "unpinned",
      project: effectGestureProject({ dependencies: [] }),
    });
    const hook = mount({ drafts: [unpinned], selected: unpinned });
    await settle();
    expect(hook.result().byDraft.get("unpinned")).toEqual({
      aliases: ["sparkle"],
      missing: ["sparkle"],
    });
    expect(library.requests).toEqual([]);
  });
});

import { jsonResponse } from "./generationFixtures";

/**
 * A stand-in for the Library's Gesture routes, as far as the creator's save
 * uses them: read one Gesture, and save one from its descriptor and clip
 * file. Test-only.
 */

export type SavedGestureRequest = {
  entryName: string;
  catalogItemId: string | null;
  expectedRevision: string | null;
  descriptor: Record<string, unknown>;
  /** The saved clip file's name and parsed content. */
  file: { name: string; clip: Record<string, unknown> };
};

export function createGestureLibraryServer() {
  const items = new Map<string, Record<string, unknown>>();
  const saves: SavedGestureRequest[] = [];
  const reads: string[] = [];
  let failNextSave: (() => Response) | null = null;
  let created = 0;

  const typedGesture = (
    itemId: string,
    descriptor: Record<string, unknown>,
    revision: number,
  ) => ({
    item_id: itemId,
    source: "local",
    logical_key: descriptor.id,
    name: descriptor.name,
    description: descriptor.description ?? null,
    semantic_key: descriptor.semantic_key,
    implementation: descriptor.implementation,
    config: {},
    dependencies: [],
    files: [],
    revision_sha256: String(revision).padStart(64, "0"),
    editable: true,
    portability: "portable",
  });

  /** Answers a Library request, or `null` when the request is not one. */
  async function handle(request: Request): Promise<Response | null> {
    const { pathname } = new URL(request.url);
    const match = /^\/v1\/gestures\/([^/]+)$/.exec(pathname);
    if (!match) {
      if (pathname === "/v1/content/catalog")
        return jsonResponse({ items: [] });
      return null;
    }
    const name = decodeURIComponent(match[1]!);
    if (request.method === "GET") {
      reads.push(name);
      const item = items.get(name);
      return item
        ? jsonResponse(item)
        : jsonResponse({ detail: { code: "content_not_found" } }, 404);
    }
    if (request.method !== "PUT") return null;
    const form = await request.formData();
    const descriptor = JSON.parse(
      String(form.get("descriptor_json")),
    ) as Record<string, unknown>;
    const file = form.get("files") as File;
    const catalogItemId = form.get("catalog_item_id");
    saves.push({
      entryName: name,
      catalogItemId: typeof catalogItemId === "string" ? catalogItemId : null,
      expectedRevision:
        typeof form.get("expected_revision") === "string"
          ? String(form.get("expected_revision"))
          : null,
      descriptor,
      file: {
        name: file.name,
        clip: JSON.parse(await file.text()) as Record<string, unknown>,
      },
    });
    if (failNextSave) {
      const refusal = failNextSave();
      failNextSave = null;
      return refusal;
    }
    const itemId =
      typeof catalogItemId === "string" ? catalogItemId : `item-${++created}`;
    const item = typedGesture(itemId, descriptor, saves.length);
    items.set(itemId, item);
    return jsonResponse(item);
  }

  return {
    handle,
    /** The save requests received, refused ones included. */
    saves,
    /** The ids of the Gestures read. */
    reads,
    items,
    /** Put a Local Gesture in the Library, as if saved earlier. */
    add(itemId: string, descriptor: Record<string, unknown>) {
      items.set(itemId, typedGesture(itemId, descriptor, 0));
    },
    refuseNextSave(response: () => Response) {
      failNextSave = response;
    },
  };
}

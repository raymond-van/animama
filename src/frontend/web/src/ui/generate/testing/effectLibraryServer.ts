import { jsonResponse } from "./generationFixtures";

/**
 * A stand-in for the Library's preview route, as far as a draft's effects use
 * it: every requested root resolves to an effect of its kind unless the test
 * says the item is gone, cannot be shown, or the route is down. Test-only.
 */
export function createEffectLibraryServer() {
  const state = {
    /** The roots of each request received, as catalog item ids. */
    requests: [] as string[][],
    /** Items the Library no longer holds. */
    gone: new Set<string>(),
    /** Items still in the Library that cannot be shown, with the code given. */
    unshown: new Map<string, string>(),
    /** The route answers every request with a failure. */
    down: false,
  };

  /** Answers a preview request, or `null` when the request is not one. */
  async function handle(request: Request): Promise<Response | null> {
    if (new URL(request.url).pathname !== "/v1/content/previews:prepare")
      return null;
    const body = (await request.json()) as {
      roots: { kind: string; source: { catalog_item_id: string } }[];
    };
    const ids = body.roots.map(({ source }) => source.catalog_item_id);
    state.requests.push(ids);
    if (state.down) return jsonResponse({ detail: "unavailable" }, 503);
    const resolved = body.roots.filter(
      ({ source }) =>
        !state.gone.has(source.catalog_item_id) &&
        !state.unshown.has(source.catalog_item_id),
    );
    return jsonResponse({
      schema_version: 1,
      complete: resolved.length === body.roots.length,
      diagnostics: ids.flatMap((id): Record<string, unknown>[] =>
        state.gone.has(id)
          ? [
              {
                root_key: `catalog:${id}`,
                code: "source_unavailable",
                message: "The selected source is unavailable.",
              },
            ]
          : state.unshown.has(id)
            ? [
                {
                  root_key: `catalog:${id}`,
                  code: state.unshown.get(id),
                  message: "The selected source could not be resolved.",
                  item_id: id,
                },
              ]
            : [],
      ),
      lease:
        resolved.length > 0
          ? {
              preview_id: `lease-${state.requests.length}`,
              revision_sha256: "a".repeat(64),
              // An hour from now, as a lease is: a far date would overflow
              // the renewal timer and renew at once.
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              files: [],
            }
          : null,
      items: resolved.map(({ kind, source }) => ({
        kind,
        item_id: source.catalog_item_id,
        source: "local",
        logical_key: `local:${kind}:${source.catalog_item_id}`,
        name: source.catalog_item_id,
        description: null,
        revision_sha256: "b".repeat(64),
        dependencies: [],
        files: [],
        editable: true,
      })),
      roots: resolved.map(({ kind, source }) => ({
        root_key: `catalog:${source.catalog_item_id}`,
        item_id: source.catalog_item_id,
        kind,
        closure_item_ids: [source.catalog_item_id],
        source: { type: "catalog", catalog_item_id: source.catalog_item_id },
      })),
    });
  }

  return Object.assign(state, { handle });
}

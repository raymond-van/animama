import { useEffect, useMemo } from "react";

/** The TanStack Router field that gates its scroll tracking listeners. */
type ScrollTrackingRouter = { isScrollRestoring: boolean };

/**
 * Build one router per ready admission and keep only the mounted one tracking
 * scroll positions.
 *
 * Each admitted session gets its own router and QueryClient. TanStack Router
 * installs document scroll and `pagehide` listeners when a router is created
 * and never removes them, so a router that is no longer mounted would keep
 * every element it saw scroll, including detached pages and canvases. No
 * router is built before admission is ready, and a retired router stops
 * tracking; its listeners then ignore events.
 */
export function useAdmittedRouter<
  TClient,
  TRouter extends ScrollTrackingRouter,
>(
  create: (queryClient: TClient) => TRouter,
  queryClient: TClient,
  ready: boolean,
): TRouter | null {
  const admitted = useMemo(() => {
    if (!ready) return null;
    const router = create(queryClient);
    const tracking = router.isScrollRestoring;
    // StrictMode can build and discard a router during render. Only the
    // mounted one turns tracking back on: here, or via <ScrollRestoration />.
    router.isScrollRestoring = false;
    return { router, tracking };
  }, [create, queryClient, ready]);

  useEffect(() => {
    if (!admitted) return;
    const { router, tracking } = admitted;
    router.isScrollRestoring = tracking;
    return () => {
      router.isScrollRestoring = false;
    };
  }, [admitted]);

  return admitted?.router ?? null;
}

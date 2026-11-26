import { useMemo } from "react";
import { useLocation, useParams } from "@tanstack/react-router";
import { useFormatters } from "@animama/product-ui/i18n";

import type { PyAnimaListItem } from "@/lib/content/catalogTypes";
import { useSettings } from "@/ui/settings/SettingsProvider";
import {
  orderSidebarAnimas,
  useSidebarAnimaSortStore,
} from "@/ui/sidebar/sidebarOrder";

/**
 * The Animas in sidebar order: the sort chosen in the sidebar, the recently
 * used Anima first under "recent", pinned Animas above the rest. On an Anima's
 * page the last chat Anima counts as recently used, as the sidebar has always
 * done.
 */
export function useSidebarAnimaOrder(
  animas: readonly PyAnimaListItem[],
): PyAnimaListItem[] {
  const { compare } = useFormatters();
  const params = useParams({ strict: false });
  const pathname = useLocation({ select: (location) => location.pathname });
  const { userSettings } = useSettings();
  const sort = useSidebarAnimaSortStore((state) => state.sort);
  const currentAnimaId =
    typeof params?.animaId === "string" ? params.animaId : null;
  const liveAnimaId =
    currentAnimaId && !pathname.startsWith("/animas/") ? currentAnimaId : null;
  const recentlyUsedAnimaId =
    liveAnimaId ?? userSettings?.last_active_anima_id ?? null;

  return useMemo(
    () => orderSidebarAnimas(animas, { sort, compare, recentlyUsedAnimaId }),
    [animas, compare, recentlyUsedAnimaId, sort],
  );
}

import { create } from "zustand";

/** How long a request waits for the Library to show before it is dropped. */
export const LIBRARY_IMPORT_REQUEST_TTL_MS = 10_000;

/**
 * A request for the Library to open its Import dialog, set by the desktop
 * menu's Import Anima before it navigates there (the dialog's state belongs
 * to the Library page). A leave guard can cancel that navigation, so the
 * request is honoured only while fresh: a later, unrelated visit to the
 * Library must not open Import by itself.
 */
export const useLibraryImportRequestStore = create<{
  requestedAt: number | null;
}>(() => ({ requestedAt: null }));

/** Ask the Library to open Import. */
export function requestLibraryImport(now: number = Date.now()): void {
  useLibraryImportRequestStore.setState({ requestedAt: now });
}

/** Clear the request; true when it was made recently enough to act on. */
export function takeLibraryImportRequest(now: number = Date.now()): boolean {
  const { requestedAt } = useLibraryImportRequestStore.getState();
  if (requestedAt === null) return false;
  useLibraryImportRequestStore.setState({ requestedAt: null });
  return now - requestedAt <= LIBRARY_IMPORT_REQUEST_TTL_MS;
}

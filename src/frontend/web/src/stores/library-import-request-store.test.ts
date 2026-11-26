import { afterEach, describe, expect, it } from "vitest";

import {
  LIBRARY_IMPORT_REQUEST_TTL_MS,
  requestLibraryImport,
  takeLibraryImportRequest,
  useLibraryImportRequestStore,
} from "./library-import-request-store";

afterEach(() => {
  useLibraryImportRequestStore.setState({ requestedAt: null });
});

describe("Library import requests", () => {
  it("opens Import once for a request the Library sees in time", () => {
    expect(takeLibraryImportRequest(1_000)).toBe(false);

    requestLibraryImport(1_000);
    expect(
      takeLibraryImportRequest(1_000 + LIBRARY_IMPORT_REQUEST_TTL_MS),
    ).toBe(true);
    expect(
      takeLibraryImportRequest(1_000 + LIBRARY_IMPORT_REQUEST_TTL_MS),
    ).toBe(false);
  });

  it("drops a request whose navigation was cancelled, on a later visit", () => {
    requestLibraryImport(1_000);

    expect(
      takeLibraryImportRequest(1_000 + LIBRARY_IMPORT_REQUEST_TTL_MS + 1),
    ).toBe(false);
    expect(useLibraryImportRequestStore.getState().requestedAt).toBeNull();
  });
});

import type { ReactNode } from "react";
import { renderToString } from "@/test/runtime-markup";
import { describe, expect, it, vi } from "vitest";
import type { PyCatalogViewItem } from "@/lib/content/catalogTypes";
import { LibrarySoundDialog } from "./LibrarySoundDialog";

vi.mock("@/hooks/useContentEditorSaveSource", () => ({
  useContentEditorSaveSource: () => ({ saved: vi.fn() }),
}));
vi.mock("@/ui/components/dialog", () => {
  const Container = ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Dialog: Container,
    DialogContent: Container,
    DialogDescription: Container,
    DialogHeader: Container,
    DialogTitle: Container,
  };
});

const item: PyCatalogViewItem = {
  item_id: "bell",
  name: "Bell",
  description: "Old metadata",
  logical_key: "sound:bell",
  origin: "owned",
  revision_sha256: "revision",
  state: "ready",
  source: null,
  created_at: null,
  updated_at: null,
};

describe("Library sound management", () => {
  it("offers rename and replacement with unchanged Save disabled", () => {
    const html = renderToString(
      <LibrarySoundDialog item={item} onClose={() => {}} />,
    );
    expect(html).toContain('value="Bell"');
    expect(html).toContain("Replace audio");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
    // Delete is the Sound's Library item menu, as for every other kind.
    expect(html).not.toContain("Delete");
    expect(html).not.toContain("Old metadata");
    expect(html).not.toContain('type="range"');
  });
  it("keeps Included sounds read-only", () => {
    const html = renderToString(
      <LibrarySoundDialog
        item={{ ...item, origin: "builtin" }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("Included sounds are read-only.");
    expect(html).not.toContain("Replace audio");
    expect(html).not.toContain("Delete</button>");
    expect(html).not.toContain("Save</button>");
  });
});

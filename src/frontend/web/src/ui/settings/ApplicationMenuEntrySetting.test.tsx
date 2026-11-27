import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { MenuEntryStatus } from "../../../../shared/desktop-runtime";
import { ApplicationMenuEntrySetting } from "./ApplicationMenuEntrySetting";

function render(status: MenuEntryStatus) {
  return renderToStaticMarkup(
    <ApplicationMenuEntrySetting
      menuEntry={{ status, pending: false, setEnabled: vi.fn() }}
    />,
  );
}

describe("Application menu entry setting", () => {
  it("renders nothing where no entry can be added", () => {
    expect(render({ available: false })).toBe("");
  });

  it("shows the switch in the entry's state", () => {
    const off = render({ available: true, enabled: false, stale: false });
    expect(off).toContain("Show in application menu");
    expect(off).toContain("application menu");
    expect(off).toContain('aria-checked="false"');
    expect(off).not.toContain("Point it at this file");
    expect(render({ available: true, enabled: true, stale: false })).toContain(
      'aria-checked="true"',
    );
  });

  it("says when the AppImage has moved and offers to repoint the entry", () => {
    const html = render({ available: true, enabled: true, stale: true });
    expect(html).toContain("has moved");
    expect(html).toContain("Point it at this file");
  });
});

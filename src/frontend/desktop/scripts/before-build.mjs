import { existsSync } from "node:fs";
import path from "node:path";
import { desktopRoot, readJson, RUNTIME_TARGETS } from "./runtime/common.mjs";
import {
  assertInventory,
  componentInventory,
  inventoryId,
} from "./runtime/inventory.mjs";

/** The embedded runtime target an electron-builder context packages. */
export function packagedTarget(context) {
  const target = `${context.platform.nodeName}-${context.arch}`;
  if (!RUNTIME_TARGETS.includes(target))
    throw new Error(
      "Embedded packaging supports macOS arm64, Windows x64 and Linux x64 only; other targets remain gated.",
    );
  return target;
}

/** Never publish a thin wrapper, stale bundle, or partial runtime as a desktop app. */
export default function beforeBuild(context) {
  const target = packagedTarget(context);
  const output = path.join(desktopRoot, ".desktop-runtime", target);
  const runtime = path.join(output, "runtime");
  if (
    existsSync(path.join(output, "stage-failure.json")) ||
    !existsSync(path.join(output, "audit-report.json"))
  )
    throw new Error(
      "Stage and audit a complete runtime before packaging. Resolve the starter-content/source gate; no wrapper fallback is allowed.",
    );
  const manifest = readJson(path.join(runtime, "manifest.json"));
  const audit = readJson(path.join(output, "audit-report.json"));
  if (
    manifest.app_version !==
      readJson(path.join(desktopRoot, "package.json")).version ||
    audit.build_id !== manifest.build_id ||
    inventoryId(manifest.files) !== manifest.build_id
  )
    throw new Error(
      "Runtime stage/audit does not match this application version.",
    );
  assertInventory(runtime, manifest.files);
  const evidence = readJson(path.join(runtime, "build-evidence.json"));
  const current = componentInventory(path.join(desktopRoot, "dist"));
  const staged = evidence.app
    .filter((file) => file.path.startsWith("dist/"))
    .map((file) => ({ ...file, path: file.path.slice(5) }));
  if (JSON.stringify(current) !== JSON.stringify(staged))
    throw new Error(
      "Desktop main/preload changed after staging. Stage and audit again before packaging.",
    );
  // The desktop build copies its small runtime dependency set into dist.
  // Returning false keeps electron-builder from trying to rebuild pnpm's
  // workspace-level node_modules layout.
  return false;
}

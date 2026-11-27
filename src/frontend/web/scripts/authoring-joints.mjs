// Generate or check the authoring joint table: the joints, components, ranges
// and base pose that `pnpm -s animation joints` and `pnpm -s animation base`
// print, as one Markdown file for authors who cannot run those commands. The
// backend packages a byte-for-byte copy as authoring guidance
// (src/backend/packaging/shared_catalogs.py).
//
//   node scripts/authoring-joints.mjs           check the tracked file
//   node scripts/authoring-joints.mjs --write   rewrite it
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const TRACKED_FILE =
  "src/lib/avatar/motion-authoring/authoring-joints.generated.md";
const REFRESH = "node scripts/authoring-joints.mjs --write";

/**
 * The joint table as Markdown, from the motion CLI's `joints` listing and
 * `base` JSON. The text is packaged as guidance, so it names no command.
 */
export function formatAuthoringJoints({ joints, base }) {
  const baseLines = Object.entries(base).map(
    ([joint, components]) =>
      `${joint}: ${Object.entries(components)
        .map(([name, value]) => `${name} ${value}`)
        .join(", ")}`,
  );
  return [
    "# Joints, ranges and base pose",
    "",
    "## Joints and components",
    "",
    "Joints that share components are listed together. Each component gives its",
    "meaning, then its natural range and its anatomical limit in degrees.",
    "",
    "```text",
    joints.trim(),
    "```",
    "",
    "## Base pose",
    "",
    'The Relaxed Rest value of each component in degrees, which `"base"` stands',
    "for.",
    "",
    "```text",
    ...baseLines,
    "```",
    "",
  ].join("\n");
}

/**
 * Run the motion CLI's `joints` and `base` commands and render their output.
 *
 * @param runMotionCli `runMotionCli` of `src/lib/avatar/motion-authoring/cli.ts`.
 */
export async function generateAuthoringJoints(runMotionCli) {
  const run = async (command) => {
    const lines = [];
    const code = await runMotionCli([command], {
      avatarDirectory: path.resolve(
        webRoot,
        "../../../content/included/avatars",
      ),
      cwd: webRoot,
      out: (text) => lines.push(text),
    });
    if (code !== 0)
      throw new Error(`The motion CLI's ${command} command exited ${code}.`);
    return lines.join("\n");
  };
  return formatAuthoringJoints({
    joints: await run("joints"),
    base: JSON.parse(await run("base")),
  });
}

/** Load the motion CLI through Vite's SSR loader, as `scripts/animation.mjs` does. */
async function loadMotionCli() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: false,
    root: webRoot,
    publicDir: false,
    logLevel: "error",
    appType: "custom",
    cacheDir: path.join(webRoot, "node_modules/.vite-animation-cli"),
    define: {
      __ANIMAMA_DEV_BUILD__: "true",
      __ANIMAMA_APP_VERSION__: '"cli"',
    },
    resolve: {
      alias: {
        "@": path.join(webRoot, "src"),
      },
    },
    server: { middlewareMode: true, hmr: false, ws: false },
  });
  try {
    return {
      cli: await server.ssrLoadModule(
        "/src/lib/avatar/motion-authoring/cli.ts",
      ),
      close: () => server.close(),
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

/** Check the tracked file, or rewrite it with `--write`. Returns the exit code. */
async function main(argv) {
  const write = argv.length === 1 && argv[0] === "--write";
  if (argv.length > 0 && !write) {
    console.error("Usage: node scripts/authoring-joints.mjs [--write]");
    return 2;
  }
  const { cli, close } = await loadMotionCli();
  let generated;
  try {
    generated = await generateAuthoringJoints(cli.runMotionCli);
  } finally {
    await close();
  }
  const file = path.join(webRoot, TRACKED_FILE);
  if (write) {
    await writeFile(file, generated);
    console.log(`Wrote ${TRACKED_FILE}.`);
    return 0;
  }
  const tracked = await readFile(file, "utf8").catch(() => null);
  if (tracked !== generated) {
    console.error(
      `${TRACKED_FILE} differs from the joint definitions; run ${REFRESH}`,
    );
    return 1;
  }
  console.log(`${TRACKED_FILE} is current.`);
  return 0;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  process.exit(await main(process.argv.slice(2)));
}

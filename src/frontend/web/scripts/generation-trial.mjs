import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

/**
 * Parity between the app and the `animama-animation` skill, measured in a real
 * page: runs the app's draft checks on a page's main thread and in its worker,
 * compares their reports with what `pnpm animation validate` and `check`
 * report in Node, and draws the app's review sheets (a render target on an
 * existing renderer) beside `pnpm animation:render`'s (a renderer of its own).
 * Prints the measurements as JSON.
 *
 *   pnpm -s generation:trial [--gl swiftshader|gpu] [--out <dir>] [--no-frames]
 *     [--rows 6] [--tile 220x330] [--clip <clip.json>]
 *
 * Without `--clip` it picks Included Gestures of different sizes. `--rows` is
 * 2 to 6, the most the app's sheets have. `--out` writes the first clip's
 * sheets there; keep it outside the repository.
 */
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(webRoot, "../../..");
const avatarDir = path.join(repoRoot, "content/included/avatars");
const gestureDir = path.join(repoRoot, "content/included/gestures");
const AVATARS = ["Andrew", "Annie"];

const viteOptions = (cacheName) => ({
  configFile: false,
  root: webRoot,
  publicDir: false,
  logLevel: "error",
  cacheDir: path.join(webRoot, `node_modules/.vite-${cacheName}`),
  define: {
    __ANIMAMA_DEV_BUILD__: "false",
    __ANIMAMA_APP_VERSION__: '"generation-trial"',
  },
  resolve: { alias: { "@": path.join(webRoot, "src") } },
});

/** Chromium flags for the software renderer or the machine's GPU. */
function glArguments(gl) {
  if (gl === "swiftshader")
    return ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
  // Headless Chromium on macOS draws on the GPU only through Metal.
  return process.platform === "darwin" ? ["--use-angle=metal"] : [];
}

/**
 * What the command line reports for each clip: the issues of
 * `animation validate` and the findings of `animation check`, which are null
 * for a clip it cannot parse.
 */
export async function nodeCheckReports(clips) {
  const server = await createServer({
    ...viteOptions("generation-trial-node"),
    appType: "custom",
    // Modules load through the SSR loader only; nothing is pre-bundled.
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false, ws: false },
  });
  try {
    const { compactClipFile } = await server.ssrLoadModule(
      "/src/lib/avatar/motion-authoring/cli.ts",
    );
    const { checkMotion } = await server.ssrLoadModule(
      "/src/lib/avatar/motion-authoring/checks.ts",
    );
    const { loadHeadlessVrm } = await server.ssrLoadModule(
      "/src/lib/avatar/motion-authoring/headlessVrm.ts",
    );
    const avatars = await Promise.all(
      AVATARS.map(async (id) => {
        const file = await readFile(path.join(avatarDir, `${id}.vrm`));
        return {
          id,
          vrm: await loadHeadlessVrm(
            file.buffer.slice(
              file.byteOffset,
              file.byteOffset + file.byteLength,
            ),
          ),
        };
      }),
    );
    return clips.map(({ id, clip }) => {
      let findings = null;
      try {
        ({ findings } = checkMotion(clip, avatars));
      } catch {
        // `animation check` refuses a clip that does not parse.
      }
      return { clip: id, issues: compactClipFile(clip).issues, findings };
    });
  } finally {
    await server.close();
  }
}

/**
 * Whether a page's draft check report says what the command line says: the
 * same issues, and the same findings, or none for a clip that does not load.
 */
export function reportMatchesNode(report, node) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return (
    same(report.issues, node.issues) &&
    (node.findings === null
      ? !report.loadable && report.findings.length === 0
      : report.loadable && same(report.findings, node.findings))
  );
}

/** Run the trial page in headless Chromium and return its measurements. */
export async function runGenerationTrial({
  clips,
  frames = true,
  rows = 6,
  tile = { width: 220, height: 330 },
  gl = "swiftshader",
}) {
  const server = await createServer({
    ...viteOptions("generation-trial"),
    optimizeDeps: {
      entries: [
        path.join(webRoot, "scripts/generation-trial/trial.ts"),
        path.join(webRoot, "src/workers/draft-checks-worker.ts"),
      ],
    },
    worker: { format: "es" },
    server: {
      host: "127.0.0.1",
      port: 0,
      fs: { allow: [webRoot, avatarDir] },
    },
  });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, args: glArguments(gl) });
    const page = await browser.newPage();
    const errors = [];
    // Any page error (including a failed module import) ends the wait early.
    const pageError = new Promise((_, reject) =>
      page.on("pageerror", (error) => {
        errors.push(error.message);
        reject(error);
      }),
    );
    pageError.catch(() => undefined);
    await page.goto(`${origin}/scripts/generation-trial/index.html`);
    await Promise.race([
      page.waitForFunction(() => window.generationTrialReady === true, null, {
        timeout: 120_000,
      }),
      pageError,
    ]);
    const result = await Promise.race([
      page.evaluate((request) => window.runGenerationTrial(request), {
        avatars: AVATARS.map((id) => ({
          id,
          url: `${origin}/@fs${path.join(avatarDir, `${id}.vrm`)}`,
        })),
        clips,
        frames,
        rows,
        tile,
      }),
      pageError,
    ]);
    if (errors.length) throw new Error(errors.join("\n"));
    return result;
  } finally {
    await browser?.close();
    await server.close();
  }
}

/** Included Gestures spread by file size, plus the longest one. */
export async function includedClipSpread() {
  const entries = [];
  for (const slug of await readdir(gestureDir)) {
    let text;
    try {
      text = await readFile(
        path.join(gestureDir, slug, `${slug}.json`),
        "utf8",
      );
    } catch {
      continue;
    }
    const clip = JSON.parse(text);
    if (clip.schema !== "animaPoseClip/2.0") continue;
    entries.push({
      id: slug,
      clip,
      bytes: Buffer.byteLength(text),
      duration: clip.duration ?? 0,
    });
  }
  entries.sort((a, b) => a.bytes - b.bytes);
  const at = (fraction) =>
    entries[
      Math.min(entries.length - 1, Math.floor(entries.length * fraction))
    ];
  const longest = entries.reduce((best, entry) =>
    entry.duration > best.duration ? entry : best,
  );
  const picked = new Map(
    [at(0), at(0.5), at(0.9), at(1), longest].map((entry) => [entry.id, entry]),
  );
  return [...picked.values()];
}

/**
 * A clip's id as a file name stem. The id is the clip author's text (a model's,
 * for a generated clip), so only plain characters name a file.
 */
export function sheetFileStem(id) {
  const stem = String(id ?? "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .slice(0, 64);
  return /[A-Za-z0-9]/.test(stem) ? stem : "clip";
}

const USAGE =
  "Usage: pnpm -s generation:trial [--gl swiftshader|gpu] [--out <dir>] [--no-frames] [--rows 6] [--tile 220x330] [--clip <clip.json>]";

async function main(argv) {
  const values = { "--gl": "swiftshader", "--rows": "6", "--tile": "220x330" };
  let frames = true;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--no-frames") {
      frames = false;
      continue;
    }
    const value = argv[index + 1];
    if (
      !["--gl", "--out", "--rows", "--tile", "--clip"].includes(name) ||
      !value
    ) {
      console.log(USAGE);
      return 2;
    }
    values[name] = value;
    index += 1;
  }
  const tileMatch = /^([1-9]\d{1,3})x([1-9]\d{1,3})$/.exec(values["--tile"]);
  const rows = Number(values["--rows"]);
  if (
    !["swiftshader", "gpu"].includes(values["--gl"]) ||
    !tileMatch ||
    !Number.isInteger(rows) ||
    rows < 2 ||
    // The app's sheets have at most six rows.
    rows > 6
  ) {
    console.log(USAGE);
    return 2;
  }
  const cwd = process.env.INIT_CWD ?? process.cwd();
  let spread;
  if (values["--clip"]) {
    const text = await readFile(path.resolve(cwd, values["--clip"]), "utf8");
    const clip = JSON.parse(text);
    spread = [{ id: clip.id ?? "clip", clip, bytes: Buffer.byteLength(text) }];
  } else {
    spread = await includedClipSpread();
  }
  const clips = spread.map(({ id, clip }) => ({ id, clip }));
  const result = await runGenerationTrial({
    clips,
    frames,
    rows,
    tile: { width: Number(tileMatch[1]), height: Number(tileMatch[2]) },
    gl: values["--gl"],
  });
  const nodeReports = await nodeCheckReports(clips);
  const sheets = [];
  if (result.frames && values["--out"]) {
    const directory = path.resolve(cwd, values["--out"]);
    await mkdir(directory, { recursive: true });
    for (const strategy of ["ownRenderer", "renderTarget"]) {
      for (const sheet of result.frames[strategy].sheets) {
        const file = path.join(
          directory,
          `${sheetFileStem(result.frames.clip)}.${sheet.avatar}.${strategy}.png`,
        );
        await writeFile(
          file,
          Buffer.from(sheet.dataUrl.split(",")[1], "base64"),
        );
        sheets.push(file);
      }
    }
  }
  const round = (value) => Math.round(value * 10) / 10;
  console.log(
    JSON.stringify(
      {
        gl: values["--gl"],
        webglRenderer: result.webglRenderer,
        avatars: result.avatars.map((avatar) => ({
          ...avatar,
          headlessLoadMs: round(avatar.headlessLoadMs),
        })),
        workerStartMs: round(result.workerStartMs),
        checks: result.checks.map((check, index) => ({
          clip: check.clip,
          bytes: spread[index].bytes,
          durationSeconds: check.durationSeconds,
          mainMs: round(check.mainMs),
          workerRoundTripMs: round(check.workerRoundTripMs),
          mainThreadMaxGapMs: round(check.mainThreadMaxGapMs),
          loadable: check.report.loadable,
          issues: check.report.issues.length,
          findings: check.report.findings.length,
          fails: check.report.findings.filter(
            (finding) => finding.severity === "fail",
          ).length,
          workerMatchesMain: check.workerMatchesMain,
          pageMatchesNode: reportMatchesNode(check.report, nodeReports[index]),
        })),
        frames: result.frames && {
          clip: result.frames.clip,
          times: result.frames.times,
          ...Object.fromEntries(
            ["ownRenderer", "renderTarget"].map((strategy) => [
              strategy,
              {
                firstMs: round(result.frames[strategy].firstMs),
                secondMs: round(result.frames[strategy].secondMs),
                sheets: result.frames[strategy].sheets.map(
                  ({ dataUrl: _dataUrl, ...sheet }) => sheet,
                ),
              },
            ]),
          ),
          renderTargetSrgbDifference: round(
            result.frames.renderTargetSrgbDifference,
          ),
          rendererUndisturbed: result.frames.rendererUndisturbed,
          framesBetween: result.frames.framesBetween,
        },
        sheets,
      },
      null,
      2,
    ),
  );
  return 0;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  process.exit(await main(process.argv.slice(2)));
}

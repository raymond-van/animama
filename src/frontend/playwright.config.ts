import path from "node:path";

import { defineConfig } from "playwright/test";

function requiredEnvironmentPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required. Run Playwright through pnpm e2e:list or pnpm e2e:test.`,
    );
  }
  return path.resolve(value);
}

const webUrl = process.env.ANIMAMA_E2E_WEB_URL?.trim();
if (!webUrl) {
  throw new Error(
    "ANIMAMA_E2E_WEB_URL is required. Run Playwright through the E2E runner.",
  );
}

const playwrightDirectory = requiredEnvironmentPath(
  "ANIMAMA_E2E_PLAYWRIGHT_DIR",
);
const headed = process.env.ANIMAMA_E2E_HEADED === "1";
// Headless WebGL renderer. macOS hosts render through the GPU with ANGLE Metal.
// Other hosts, such as Linux validation containers, have no usable GPU and use
// SwiftShader, which renders on the CPU and slows every Avatar canvas.
const webgl =
  process.env.ANIMAMA_E2E_WEBGL?.trim() ||
  (process.platform === "darwin" ? "metal" : "swiftshader");
const webglArgs: Record<string, string[]> = {
  metal: ["--use-angle=metal"],
  swiftshader: [
    "--use-gl=angle",
    "--use-angle=swiftshader-webgl",
    "--enable-unsafe-swiftshader",
  ],
};
if (!Object.hasOwn(webglArgs, webgl)) {
  throw new Error(
    `ANIMAMA_E2E_WEBGL must be one of ${Object.keys(webglArgs).join(", ")}.`,
  );
}
const chromiumUse = { browserName: "chromium" as const };
// The pseudo-locale exists only in development builds, so its smoke check is a
// separate suite selected by `pnpm e2e:test:pseudo`. Ordinary journeys stay
// English and never include it.
const pseudoSuite = process.env.ANIMAMA_E2E_SUITE === "pseudo";

export default defineConfig({
  testDir: "./e2e",
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFilePath}/{arg}{ext}",
  // Missing or changed baselines fail routine runs. An implementation-time
  // `--update-snapshots` flag is required to write an intentional candidate.
  updateSnapshots: "none",
  outputDir: path.join(playwrightDirectory, "output"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    // Keep colored journey pass/fail lines in the terminal without printing
    // every successful assertion group. Steps remain in HTML and JSON reports,
    // and Playwright still names the exact failed step in failure output.
    ["list", { printSteps: false }],
    [
      "html",
      {
        outputFolder: path.join(playwrightDirectory, "html-report"),
        open: "never",
      },
    ],
    ["json", { outputFile: path.join(playwrightDirectory, "results.json") }],
  ],
  use: {
    baseURL: webUrl,
    // Setup now waits for the Anima to open, so it needs the same WebGL
    // renderer as the journeys. Headed runs use the normal hardware path.
    launchOptions: {
      args: headed ? [] : webglArgs[webgl],
    },
    viewport: { width: 1_440, height: 900 },
    timezoneId: "America/Toronto",
    locale: "en-CA",
    contextOptions: {
      reducedMotion: "no-preference",
    },
    actionTimeout: 10_000,
    navigationTimeout: 45_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Capture only isolated fixture data; setup keeps trace/video disabled.
    video: headed ? "on" : "retain-on-failure",
  },
  projects: [
    {
      name: "installation-setup",
      testMatch: /.*\.setup\.ts/,
      use: {
        trace: "off",
        screenshot: "off",
        video: "off",
      },
    },
    pseudoSuite
      ? {
          name: "pseudo",
          testMatch: /pseudo-locale\.smoke\.spec\.ts/,
          dependencies: ["installation-setup"],
          use: chromiumUse,
        }
      : {
          name: "chromium",
          testMatch:
            /accountless-(?:library|journeys|vfx-layout|pose-content|content-sharing|imported-playback|numeric-input|creator-discard(?:-local)?|effect-template-picker|avatar-effect-direct-manipulation|creator-generated-gesture|generate-gesture|particle-texture-import|scene-layers)\.spec\.ts/,
          dependencies: ["installation-setup"],
          use: chromiumUse,
        },
  ],
});

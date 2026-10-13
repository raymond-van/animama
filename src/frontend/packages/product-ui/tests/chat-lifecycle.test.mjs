import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let temporary;
let browser;
let bundle;

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "animama-chat-consumer-"));
  const modules = join(temporary, "node_modules");
  // Copy only publishable package inputs. Third-party dependencies reuse the
  // installed graph, but neither package may resolve back to workspace source.
  for (const name of ["product-ui", "runtime-contracts"]) {
    const source = resolve(packageRoot, "..", name);
    const target = join(modules, "@animama", name);
    await mkdir(target, { recursive: true });
    await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
    await cp(join(source, "package.json"), join(target, "package.json"));
    const manifest = JSON.parse(
      await readFile(join(source, "package.json"), "utf8"),
    );
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    })) {
      if (dependency.startsWith("@animama/")) continue;
      const link = join(modules, dependency);
      await mkdir(dirname(link), { recursive: true });
      await symlink(join(source, "node_modules", dependency), link).catch(
        (error) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
    }
  }
  await cp(
    join(packageRoot, "tests/chat-consumer.jsx"),
    join(temporary, "consumer.jsx"),
  );
  const result = await build({
    absWorkingDir: temporary,
    entryPoints: ["consumer.jsx"],
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: "consumer.js",
    write: false,
    metafile: true,
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const inputs = Object.keys(result.metafile.inputs).map((path) =>
    resolve(temporary, path),
  );
  assert(
    inputs.some((path) =>
      path.startsWith(join(modules, "@animama/product-ui/dist")),
    ),
  );
  assert(
    inputs.some((path) =>
      path.startsWith(join(modules, "@animama/runtime-contracts/dist")),
    ),
  );
  assert(
    !inputs.some((path) =>
      path.startsWith(resolve(packageRoot, "../..", "web")),
    ),
  );
  assert(
    !inputs.some((path) =>
      /packages\/(product-ui|runtime-contracts)\/(src|dist)\//.test(path),
    ),
  );
  bundle = result.outputFiles.find(
    (file) => file.path.endsWith(".js") || file.path === "<stdout>",
  ).text;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

/** Each test owns a fresh DOM, hook instance, transport and event transcript. */
async function consumer(t) {
  const page = await browser.newPage();
  // Generous for two-core CI runners.
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector("#start");
  return page;
}
async function start(page, count = 1) {
  await page.click("#start");
  await page.waitForFunction(
    (count) => window.fixture.requests().length === count,
    count,
  );
}
async function idle(page) {
  await page.waitForFunction(
    () => window.fixture.settled().length === window.fixture.requests().length,
  );
  await page.waitForFunction(
    () => document.querySelector("#streaming")?.textContent === "false",
  );
  assert.equal(await page.isDisabled("#stop"), true);
}

test("built consumer uses its injected owner and transport and receives incremental text", async (t) => {
  const page = await consumer(t);
  assert.equal(await page.textContent("#owner"), "owner-fixture");
  await start(page);
  const [request] = await page.evaluate(() => window.fixture.requests());
  assert.equal(
    request.url,
    "https://chat-fixture.invalid/v1/animas/anima-fixture/chat:sse",
  );
  assert.equal(request.method, "POST");
  assert.equal(request.body.run_id, "run-1");
  assert.equal(request.authorization, null);
  await page.evaluate(() => {
    window.fixture.respond(0);
    window.fixture.send(0, [{ text: "first", run_id: "run-1" }]);
  });
  await page.waitForFunction(
    () => document.querySelector("#transcript").textContent === "first",
  );
  assert.equal(await page.textContent("#streaming"), "true");
  await page.evaluate(() => {
    window.fixture.send(0, [{ run_id: "run-1", chat_id: "chat-fixture" }]);
    window.fixture.close(0);
  });
  await idle(page);
  assert.deepEqual(await page.evaluate(() => window.fixture.events()), [
    ["open", "run-1"],
    ["token", "first"],
    ["complete", "run-1"],
  ]);
});

test("a completed run releases transport without waiting for EOF", async (t) => {
  const page = await consumer(t);
  await start(page);
  await page.evaluate(() => {
    window.fixture.respond(0);
    window.fixture.send(0, [{ run_id: "run-1" }]);
  });
  await idle(page);
  assert.equal(
    (await page.evaluate(() => window.fixture.requests()))[0].aborted,
    true,
  );
  assert.deepEqual(await page.evaluate(() => window.fixture.events()), [
    ["open", "run-1"],
    ["complete", "run-1"],
  ]);
});

test("Stop aborts transport and discards buffered late transcript and store callbacks", async (t) => {
  const page = await consumer(t);
  await start(page);
  // Stop in the same task that releases response bytes, before promise continuations.
  const abortedOnStop = await page.evaluate(() => {
    window.fixture.respond(0);
    window.fixture.send(0, [
      { text: "late", run_id: "run-1" },
      { emotions: [], run_id: "run-1" },
      { type: "chat.title.updated", title: "late", run_id: "run-1" },
      {
        gesture: "wave",
        runtime_revision: "revision-fixture",
        run_id: "run-1",
      },
      { run_id: "run-1" },
    ]);
    window.fixture.stop();
    window.fixture.close(0);
    return window.fixture.requests()[0].aborted;
  });
  assert.equal(abortedOnStop, true);
  await idle(page);
  assert.equal(
    (await page.evaluate(() => window.fixture.requests()))[0].aborted,
    true,
  );
  assert.equal(await page.textContent("#transcript"), "");
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.events().filter(([kind]) => kind !== "open"),
    ),
    [],
  );
  assert.equal(
    (await page.evaluate(() => window.fixture.requests())).length,
    1,
  );
});

test("Stop cancels an open stream and permits a fresh Start", async (t) => {
  const page = await consumer(t);
  await start(page);
  await page.evaluate(() => {
    window.fixture.respond(0);
    window.fixture.send(0, [{ text: "first" }]);
  });
  await page.waitForFunction(
    () => document.querySelector("#transcript").textContent === "first",
  );
  await page.click("#stop");
  await idle(page);
  await page.waitForFunction(() => window.fixture.requests()[0].cancelled);
  assert.equal(
    (await page.evaluate(() => window.fixture.requests()))[0].aborted,
    true,
  );
  await start(page, 2);
  await page.evaluate(() => {
    window.fixture.respond(1);
    window.fixture.close(1);
  });
  await idle(page);
});

test("unmount aborts pending work and prevents late callbacks", async (t) => {
  const page = await consumer(t);
  await start(page);
  const before = await page.evaluate(() => {
    window.fixture.unmount();
    return window.fixture.events();
  });
  assert.equal(
    (await page.evaluate(() => window.fixture.requests()))[0].aborted,
    true,
  );
  await page.evaluate(() => {
    window.fixture.respond(0);
    window.fixture.send(0, [{ text: "late" }, { run_id: "run-1" }]);
    window.fixture.close(0);
  });
  await page.waitForFunction(() => window.fixture.settled().includes("run-1"));
  assert.deepEqual(await page.evaluate(() => window.fixture.events()), before);
});

test("replaced stream cannot clear active controls or deliver stale events", async (t) => {
  const page = await consumer(t);
  await start(page);
  await start(page, 2);
  assert.equal(
    (await page.evaluate(() => window.fixture.requests()))[0].aborted,
    true,
  );
  await page.evaluate(() => {
    window.fixture.respond(0);
    window.fixture.send(0, [{ text: "old" }, { run_id: "run-1" }]);
    window.fixture.close(0);
  });
  await page.waitForFunction(() => window.fixture.settled().includes("run-1"));
  assert.equal(await page.textContent("#streaming"), "true");
  assert.equal(await page.textContent("#transcript"), "");
  await page.evaluate(() => {
    window.fixture.respond(1);
    window.fixture.send(1, [
      { text: "wrong", run_id: "run-1" },
      { error: "stale error", run_id: "run-1" },
      { text: "new", run_id: "run-2" },
      { run_id: "run-2" },
    ]);
    window.fixture.close(1);
  });
  await idle(page);
  assert.equal(await page.textContent("#transcript"), "new");
  assert.equal(
    (await page.evaluate(() => window.fixture.events())).filter(
      ([kind]) => kind === "error",
    ).length,
    0,
  );
});

test("Stop during a token callback discards already parsed frames", async (t) => {
  const page = await consumer(t);
  await start(page);
  await page.evaluate(() => {
    window.fixture.stopOnToken();
    window.fixture.respond(0);
    window.fixture.send(0, [
      { text: "first" },
      { text: "late" },
      { emotions: [] },
      { run_id: "run-1" },
    ]);
    window.fixture.close(0);
  });
  await page.waitForFunction(() => window.fixture.settled().includes("run-1"));
  await idle(page);
  assert.equal(await page.textContent("#transcript"), "first");
  assert.deepEqual(await page.evaluate(() => window.fixture.events()), [
    ["open", "run-1"],
    ["token", "first"],
  ]);
  assert.equal(
    (await page.evaluate(() => window.fixture.requests()))[0].aborted,
    true,
  );
});

test("changing injected owner releases the previous mounted stream", async (t) => {
  const page = await consumer(t);
  await start(page);
  await page.evaluate(() => window.fixture.mount("second-owner"));
  await page.waitForFunction(
    () => document.querySelector("#owner").textContent === "second-owner",
  );
  assert.equal(
    (await page.evaluate(() => window.fixture.requests()))[0].aborted,
    true,
  );
  await page.evaluate(() => {
    window.fixture.respond(0);
    window.fixture.close(0);
  });
  await page.waitForFunction(() => window.fixture.settled().includes("run-1"));
  await idle(page);
  assert.equal(await page.textContent("#transcript"), "");
  await start(page, 2);
  await page.evaluate(() => {
    window.fixture.respond(1);
    window.fixture.close(1);
  });
  await idle(page);
});

for (const mode of ["incomplete", "http-error", "stream-error"]) {
  test(`${mode} restores controls without retrying the POST`, async (t) => {
    const page = await consumer(t);
    await start(page);
    await page.evaluate((mode) => {
      window.fixture.respond(0, mode === "http-error" ? 503 : 200);
      if (mode === "stream-error") window.fixture.fail(0);
      else window.fixture.close(0);
    }, mode);
    await idle(page);
    const events = await page.evaluate(() => window.fixture.events());
    assert.equal(events.filter(([kind]) => kind === "complete").length, 0);
    assert.equal(events.filter(([kind]) => kind === "error").length, 1);
    assert.equal(
      (await page.evaluate(() => window.fixture.requests())).length,
      1,
    );
  });
}

test("an error is terminal: duplicate errors, late text and run.completed cannot finalize it", async (t) => {
  const page = await consumer(t);
  await start(page);
  await page.evaluate(() => {
    window.fixture.respond(0);
    window.fixture.send(0, [
      { error: "missing key", code: "missing_api_key", run_id: "run-1" },
      { error: "duplicate", run_id: "run-1" },
      { text: "not a success", run_id: "run-1" },
      { run_id: "run-1" },
    ]);
  });
  await idle(page);
  const events = await page.evaluate(() => window.fixture.events());
  assert.equal(events.filter(([kind]) => kind === "error").length, 1);
  assert.equal(
    events.filter(([kind]) => kind === "complete" || kind === "token").length,
    0,
  );
});

test("memory cue frames reach only their run and are never read as replies or completion", async (t) => {
  const page = await consumer(t);
  await start(page);
  await page.evaluate(() => {
    window.fixture.respond(0);
    const cue = (text) => ({
      episode: { text },
      memories: { entry_id: "mem-1", version: 2, excerpt: "- Tea" },
    });
    window.fixture.send(0, [
      { text: "reply", run_id: "run-1" },
      {
        type: "memory.updated",
        run_id: "run-other",
        message_id: 1,
        memory_cue: cue("stale run"),
      },
      {
        type: "memory.updated",
        run_id: "run-1",
        message_id: 2,
        memory_cue: { episode: null, memories: null },
      },
      {
        type: "memory.updated",
        run_id: "run-1",
        message_id: 3,
        memory_cue: cue("Loves tea"),
      },
    ]);
  });
  await page.waitForFunction(() =>
    window.fixture.events().some(([kind]) => kind === "memory"),
  );
  // The memory frame was not taken for completion, so the stream stays open.
  assert.equal(await page.textContent("#streaming"), "true");
  await page.evaluate(() => {
    window.fixture.send(0, [{ run_id: "run-1" }]);
  });
  await idle(page);
  assert.equal(await page.textContent("#transcript"), "reply");
  assert.deepEqual(await page.evaluate(() => window.fixture.events()), [
    ["open", "run-1"],
    ["token", "reply"],
    ["memory", "run-1", "Loves tea", "mem-1"],
    ["complete", "run-1"],
  ]);
});

test("known error guidance is specific and unknown payloads never become display text", async (t) => {
  const page = await consumer(t);
  const values = await page.evaluate(() => {
    const codes = [
      "missing_api_key",
      "openai_authentication_error",
      "openai_permission_denied",
      "openai_quota_exceeded",
      "openai_rate_limit",
      "openai_overloaded",
      "openai_timeout",
      "chat_stream_interrupted",
    ];
    return {
      known: codes.map((code) =>
        window.fixture.describeFailure(
          { code, details: { retry_after_seconds: 3.2 } },
          "hello",
        ),
      ),
      unknown: window.fixture.describeFailure(
        {
          code: "secret_key",
          error: "secret payload",
          details: { body: "secret prompt" },
        },
        "hello",
      ),
      gateway: window.fixture.describeFailure(
        { status: 403, body: { error: "gateway_request_rejected" } },
        "hello",
      ),
      denied: window.fixture.describeFailure({ status: 403 }, "hello"),
      network: window.fixture.describeFailure(
        new TypeError("secret URL"),
        "hello",
      ),
    };
  });
  assert.equal(
    new Set(values.known.map((value) => value.title)).size,
    values.known.length,
  );
  assert.equal(values.known[4].retryAfterSeconds, 4);
  assert.equal(values.unknown.code, "chat_request_failed");
  assert(!JSON.stringify(values).includes("secret"));
  assert.equal(values.gateway.code, "gateway_request_rejected");
  assert.equal(values.denied.code, "chat_request_failed");
  assert.match(values.network.title, /connect/);
});

async function sessionConsumer(t) {
  const page = await consumer(t);
  await page.evaluate(() => window.fixture.mountSession());
  await page.waitForFunction(
    () => document.querySelector("#submit")?.disabled === false,
  );
  return page;
}
async function submitSession(page, text, count = 1) {
  await page.fill("#draft", text);
  await page.click("#submit");
  await page.waitForFunction(
    (count) => window.fixture.requests().length === count,
    count,
  );
}
async function sessionIdle(page) {
  await page.waitForFunction(
    () => document.querySelector("#streaming").textContent === "false",
  );
}

test("server speech session reaches the playback adapter without provider credentials", async (t) => {
  const page = await consumer(t);
  await page.evaluate(() => window.fixture.enableSpeech());
  await page.waitForFunction(
    () => document.querySelector("#submit")?.disabled === false,
  );
  await submitSession(page, "Speak through the admitted server");
  await page.evaluate(() => {
    window.fixture.respond(0);
    const run_id = window.fixture.requests()[0].body.run_id;
    window.fixture.send(0, [
      {
        type: "tts.session",
        run_id,
        provider: "elevenlabs",
        transport: "server",
        websocket_url: "/v1/voice/streams/fixture",
        voice_id: "voice-fixture",
        model_id: "eleven_v4_turbo",
        output_format: "pcm_24000",
        sync_alignment: true,
      },
    ]);
    window.fixture.close(0);
  });
  await sessionIdle(page);
  const received = await page.evaluate(() => ({
    sessions: window.fixture.speechSessions(),
    failures: window.fixture.speechFailures(),
  }));
  assert.deepEqual(received.failures, []);
  assert.equal(received.sessions.length, 1);
  assert.equal(received.sessions[0].value.transport, "server");
  assert.equal(
    received.sessions[0].value.websocket_url,
    "/v1/voice/streams/fixture",
  );
  assert.equal(received.sessions[0].value.token, null);
});

const allowanceExhausted = {
  provider: "elevenlabs",
  code: "speech_allowance_exhausted",
  error: "This month's voice allowance is used up.",
};

/** Submit one turn with ElevenLabs speech; returns the page and its run id. */
async function speechTurn(t, options) {
  const page = await consumer(t);
  await page.evaluate(
    (options) => window.fixture.enableSpeech(options),
    options,
  );
  await page.waitForFunction(
    () => document.querySelector("#submit")?.disabled === false,
  );
  await submitSession(page, "Say something");
  const runId = await page.evaluate(() => {
    window.fixture.respond(0);
    return window.fixture.requests()[0].body.run_id;
  });
  return { page, runId };
}

/** Stream frames for the turn's run, then wait for the turn to settle. */
async function streamSpeechTurn(page, runId, frames) {
  await page.evaluate(
    ({ runId, frames }) =>
      window.fixture.send(
        0,
        frames.map((frame) => ({ ...frame, run_id: runId })),
      ),
    { runId, frames },
  );
  await sessionIdle(page);
  return page.evaluate(() => ({
    sessions: window.fixture.speechSessions(),
    failures: window.fixture.speechFailures(),
    fallbacks: window.fixture.speechFallbacks(),
    tokens: window.fixture.ttsTokens(),
    completions: window.fixture.ttsCompletions(),
    finalizedAudio: window.fixture.finalizedAudio(),
    finalizedCompletions: window.fixture.finalizedCompletions(),
  }));
}

test("a voice allowance exhausted before the reply moves its speech to Pocket TTS", async (t) => {
  const { page, runId } = await speechTurn(t);
  const speech = await streamSpeechTurn(page, runId, [
    { type: "tts.session.error", ...allowanceExhausted },
    // No descriptor follows a decline; a stray one stays unused.
    {
      type: "tts.session",
      provider: "elevenlabs",
      transport: "server",
      websocket_url: "/v1/voice/streams/fixture",
      voice_id: "voice-fixture",
      model_id: "eleven_v4_turbo",
      output_format: "pcm_24000",
      sync_alignment: false,
    },
    { text: "Hello from the built-in voice." },
    { chat_id: "chat-fixture" },
  ]);
  assert.deepEqual(speech.fallbacks, [runId]);
  assert.deepEqual(speech.failures, []);
  assert.deepEqual(speech.sessions, []);
  assert.deepEqual(speech.tokens, [
    { runId, token: "Hello from the built-in voice." },
  ]);
  assert.deepEqual(speech.completions, [runId]);
});

test("a voice allowance exhausted after the reply text speaks the reply with Pocket TTS", async (t) => {
  const { page, runId } = await speechTurn(t);
  const speech = await streamSpeechTurn(page, runId, [
    {
      text: "Hi there.",
      response_part: "speech",
      is_delta: true,
      part_index: 0,
    },
    {
      text: "",
      response_part: "speech",
      is_delta: true,
      part_index: 0,
      part_final: true,
    },
    // Found while reserving the reply's speech, so it follows the text.
    { type: "tts.session.error", ...allowanceExhausted },
    { chat_id: "chat-fixture" },
  ]);
  assert.deepEqual(speech.fallbacks, [runId]);
  assert.deepEqual(speech.failures, []);
  assert.deepEqual(speech.tokens, [{ runId, token: "Hi there." }]);
  // The speech part already completed the run; the switch does not repeat it.
  assert.deepEqual(speech.completions, [runId]);
});

test("Gemini audio the server pushes reaches the finalized playback adapter", async (t) => {
  const { page, runId } = await speechTurn(t, {
    provider: "gemini",
    model: "gemini-3.8-flash-lite-tts",
  });
  const speech = await streamSpeechTurn(page, runId, [
    {
      text: "Hi there.",
      response_part: "speech",
      is_delta: true,
      part_index: 0,
    },
    {
      type: "tts.audio",
      provider: "gemini",
      model_id: "gemini-3.8-flash-lite-tts",
      output_format: "pcm_24000",
      audio_base64: "AAA=",
    },
    {
      type: "tts.done",
      provider: "gemini",
      model_id: "gemini-3.8-flash-lite-tts",
      output_format: "pcm_24000",
    },
    { chat_id: "chat-fixture" },
  ]);
  assert.deepEqual(speech.finalizedAudio, [{ runId, provider: "gemini" }]);
  assert.deepEqual(speech.finalizedCompletions, [runId]);
  assert.deepEqual(speech.failures, []);
  assert.deepEqual(speech.sessions, []);
});

test("a Gemini speech error ends the run's speech without Pocket TTS", async (t) => {
  const { page, runId } = await speechTurn(t, {
    provider: "gemini",
    model: "gemini-3.8-flash-lite-tts",
  });
  const speech = await streamSpeechTurn(page, runId, [
    {
      text: "Hi there.",
      response_part: "speech",
      is_delta: true,
      part_index: 0,
    },
    {
      type: "tts.error",
      provider: "gemini",
      model_id: "gemini-3.8-flash-lite-tts",
      output_format: "pcm_24000",
      code: "gemini_tts_missing_credential",
      error: "Gemini text-to-speech needs a Gemini API key.",
    },
    { chat_id: "chat-fixture" },
  ]);
  assert.deepEqual(speech.fallbacks, []);
  assert.deepEqual(
    speech.failures.map(({ runId, error }) => [runId, error.code]),
    [[runId, "gemini_tts_missing_credential"]],
  );
  assert.deepEqual(speech.finalizedAudio, []);
});

test("a Gemini speech decline never moves the reply to Pocket TTS and keeps its text", async (t) => {
  const { page, runId } = await speechTurn(t, {
    provider: "gemini",
    model: "gemini-3.8-flash-lite-tts",
  });
  const speech = await streamSpeechTurn(page, runId, [
    {
      text: "Hi there.",
      response_part: "speech",
      is_delta: true,
      part_index: 0,
    },
    {
      type: "tts.error",
      ...allowanceExhausted,
      provider: "gemini",
      model_id: "gemini-3.8-flash-lite-tts",
      output_format: "pcm_24000",
    },
    { chat_id: "chat-fixture" },
  ]);
  // The allowance fallback belongs to ElevenLabs; a Gemini error only ends speech.
  assert.deepEqual(speech.fallbacks, []);
  assert.deepEqual(
    speech.failures.map(({ runId, error }) => [runId, error.code]),
    [[runId, allowanceExhausted.code]],
  );
  assert.match(await page.textContent("main"), /Hi there\./);
});

test("other speech errors end the run's speech without Pocket TTS", async (t) => {
  const { page, runId } = await speechTurn(t);
  const speech = await streamSpeechTurn(page, runId, [
    {
      type: "tts.session.error",
      provider: "elevenlabs",
      code: "elevenlabs_session_failed",
      error: "Voice unavailable.",
    },
    { text: "Text only." },
    { chat_id: "chat-fixture" },
  ]);
  assert.deepEqual(speech.fallbacks, []);
  assert.deepEqual(
    speech.failures.map(({ runId, error }) => [runId, error.code]),
    [[runId, "elevenlabs_session_failed"]],
  );
  assert.deepEqual(speech.tokens, []);
  assert.deepEqual(speech.completions, []);
});

test("an exhausted allowance Pocket TTS cannot take keeps the speech failure", async (t) => {
  const { page, runId } = await speechTurn(t, { fallback: false });
  const speech = await streamSpeechTurn(page, runId, [
    { type: "tts.session.error", ...allowanceExhausted },
    { text: "Text only." },
    { chat_id: "chat-fixture" },
  ]);
  assert.deepEqual(speech.fallbacks, [runId]);
  assert.deepEqual(
    speech.failures.map(({ runId, error }) => [runId, error.code]),
    [[runId, "speech_allowance_exhausted"]],
  );
  assert.deepEqual(speech.tokens, []);
  assert.deepEqual(speech.completions, []);
});

test("completed turns and related cache effects stay in the distinct browser session partition", async (t) => {
  const page = await consumer(t);
  await page.evaluate(() => {
    window.fixture.mountSession("browser-lifetime-fixture");
    window.fixture.seedSessionCaches("browser-lifetime-fixture");
    window.fixture.seedSessionCaches("owner-fixture");
  });
  await page.waitForFunction(
    () => document.querySelector("#submit")?.disabled === false,
  );
  assert.equal(await page.textContent("#owner"), "owner-fixture");
  await submitSession(page, "Keep this completed turn");
  await page.evaluate(() => {
    window.fixture.respond(0);
    const run_id = window.fixture.requests()[0].body.run_id;
    window.fixture.send(0, [
      { text: "Visible after finalization", run_id },
      {
        type: "chat.title.updated",
        chat_id: "chat-fixture",
        title: "Session title",
        run_id,
      },
      { emotions: [{ emotion: "joy", value: 12 }], run_id },
      { gesture: "wave", runtime_revision: "different-revision", run_id },
      {
        type: "memory.updated",
        run_id,
        memory_cue: {
          episode: { text: "A completed turn" },
          memories: {
            entry_id: "mem-fixture",
            version: 2,
            excerpt: "Completed turn",
          },
        },
      },
      { chat_id: "chat-fixture", run_id },
    ]);
    window.fixture.close(0);
  });
  await sessionIdle(page);
  await page.waitForFunction(
    () => document.querySelector("#finalizing").textContent === "false",
  );
  const caches = await page.evaluate(() => ({
    session: window.fixture.sessionCaches("browser-lifetime-fixture"),
    owner: window.fixture.sessionCaches("owner-fixture"),
  }));
  assert.deepEqual(
    caches.session.messages.map(({ content }) => content),
    ["Keep this completed turn", "Visible after finalization"],
  );
  assert.equal(caches.session.title, "Session title");
  assert.equal(caches.session.joy, 12);
  assert.deepEqual(caches.session.invalidated, [true, true, true, true]);
  assert.equal(caches.owner.messages, undefined);
  assert.equal(caches.owner.title, "Before");
  assert.equal(caches.owner.joy, 0);
  assert.deepEqual(caches.owner.invalidated, [false, false, false, false]);
  await page.getByText("Keep this completed turn", { exact: true }).waitFor();
  await page.getByText("Visible after finalization", { exact: true }).waitFor();
});

test("failed session retains partial text and restores a message without sending or overwriting a draft", async (t) => {
  const page = await sessionConsumer(t);
  await submitSession(page, "original message");
  await page.evaluate(() => {
    window.fixture.respond(0);
    const run_id = window.fixture.requests()[0].body.run_id;
    window.fixture.send(0, [{ text: "Partial answer", run_id }]);
  });
  await page.getByText("Partial answer", { exact: true }).waitFor();
  await page.evaluate(() => window.fixture.close(0));
  await page.getByRole("alert").waitFor();
  await sessionIdle(page);
  assert.match(await page.getByRole("alert").textContent(), /interrupted/);
  await page.getByText("Incomplete reply", { exact: true }).waitFor();
  await page.getByText("Partial answer", { exact: true }).waitFor();
  await page.fill("#draft", "new draft");
  assert.equal(
    await page.getByRole("button", { name: "Restore message" }).isDisabled(),
    true,
  );
  assert.equal(await page.inputValue("#draft"), "new draft");
  await page.fill("#draft", "");
  await page.getByRole("button", { name: "Restore message" }).click();
  assert.equal(await page.inputValue("#draft"), "original message");
  assert.equal(
    (await page.evaluate(() => window.fixture.requests())).length,
    1,
  );
  await page.evaluate(() => window.fixture.switchChat());
  await page.waitForFunction(
    () => document.querySelectorAll('[role="alert"]').length === 0,
  );
});

test("provider failure stays visible after terminal frame and a later successful turn", async (t) => {
  const page = await sessionConsumer(t);
  await submitSession(page, "failed message");
  await page.evaluate(() => {
    window.fixture.respond(0);
    const run_id = window.fixture.requests()[0].body.run_id;
    window.fixture.send(0, [
      { error: "do not expose raw payload", code: "missing_api_key", run_id },
      { run_id },
    ]);
  });
  await page.getByRole("alert").waitFor();
  await sessionIdle(page);
  assert.match(
    await page.getByRole("alert").textContent(),
    /has no API key configured/,
  );
  assert(!(await page.textContent("body")).includes("raw payload"));
  await submitSession(page, "next message", 2);
  await page.evaluate(() => {
    window.fixture.respond(1);
    const run_id = window.fixture.requests()[1].body.run_id;
    window.fixture.send(1, [
      { text: "Successful answer", run_id },
      { run_id, chat_id: "chat-fixture" },
    ]);
  });
  await sessionIdle(page);
  await page.getByText("Successful answer", { exact: true }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 1);
  const text = await page.textContent('[aria-label="Conversation"]');
  assert(
    text.indexOf("has no API key configured") < text.indexOf("next message"),
  );
  assert.equal(
    (await page.evaluate(() => window.fixture.requests())).length,
    2,
  );
});

test("a completed trial links the failed turn to the desktop download", async (t) => {
  const page = await sessionConsumer(t);
  await submitSession(page, "one more message");
  await page.evaluate(() => {
    window.fixture.respond(0);
    const run_id = window.fixture.requests()[0].body.run_id;
    window.fixture.send(0, [
      { text: "Partial", run_id },
      {
        error: "trial_complete",
        code: "trial_complete",
        run_id,
        details: {
          limit: "account_trial_ai",
          download_url: "https://animama.example/download",
        },
      },
    ]);
  });
  await page.getByRole("alert").waitFor();
  await sessionIdle(page);
  assert.match(
    await page.getByRole("alert").textContent(),
    /Your Animama trial is complete\.Download Animama to keep chatting with your Animas\./,
  );
  const link = page.getByRole("link", { name: "Download Animama" });
  assert.equal(
    await link.getAttribute("href"),
    "https://animama.example/download",
  );
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  assert(
    !/installation|owner/i.test(
      await page.textContent('[aria-label="Conversation"]'),
    ),
  );
});

test("a completed trial without a safe download URL explains itself without a link", async (t) => {
  const page = await sessionConsumer(t);
  await submitSession(page, "one more message");
  await page.evaluate(() =>
    window.fixture.respond(0, 403, {
      code: "trial_complete",
      error: "trial_complete",
      limit: "account_trial_ai",
      download_url: "http://animama.example/download",
    }),
  );
  await page.getByRole("alert").waitFor();
  await sessionIdle(page);
  assert.match(
    await page.getByRole("alert").textContent(),
    /Your Animama trial is complete\./,
  );
  assert.equal(await page.getByRole("link").count(), 0);
});

test("intentional Stop never creates an error notice", async (t) => {
  const page = await sessionConsumer(t);
  await submitSession(page, "stop this");
  await page.evaluate(() => window.fixture.respond(0));
  await page.click("#stop");
  await sessionIdle(page);
  assert.equal(await page.getByRole("alert").count(), 0);
});

test("text and error in one chunk preserve the partial answer without success", async (t) => {
  const page = await sessionConsumer(t);
  await submitSession(page, "same chunk");
  await page.evaluate(() => {
    window.fixture.respond(0);
    const run_id = window.fixture.requests()[0].body.run_id;
    window.fixture.send(0, [
      { text: "Keep this partial text", run_id },
      { error: "failure", code: "openai_overloaded", run_id },
      { run_id },
    ]);
  });
  await page.getByRole("alert").waitFor();
  await sessionIdle(page);
  await page.getByText("Keep this partial text", { exact: true }).waitFor();
  assert.match(
    await page.getByRole("alert").textContent(),
    /temporarily unavailable/,
  );
  assert.equal(
    (await page.evaluate(() => window.fixture.requests())).length,
    1,
  );
});

test("a streamed memory cue stays on the reply's last bubble after completion and reload", async (t) => {
  const page = await sessionConsumer(t);
  await page.evaluate(() => window.fixture.seedMemoryCaches());
  await submitSession(page, "I adopted a cat");
  const runId = await page.evaluate(() => {
    window.fixture.respond(0);
    const run_id = window.fixture.requests()[0].body.run_id;
    const part = (response_part, text) => ({
      text,
      response_part,
      is_delta: false,
      part_final: true,
      run_id,
    });
    window.fixture.send(0, [
      part("speech", "A cat!"),
      part("display", "Tell me everything."),
      {
        type: "memory.updated",
        run_id,
        message_id: 7,
        memory_cue: {
          episode: { text: "They adopted a cat." },
          memories: { entry_id: "mem-annie", version: 2, excerpt: "- Cat" },
        },
      },
    ]);
    return run_id;
  });
  const cues = () =>
    page.$$eval("[data-memory-cue]", (nodes) =>
      nodes.map((node) => [node.dataset.memoryCue, node.textContent]),
    );
  // Speech and display render as two bubbles; only the last carries the cue.
  await page.locator("[data-memory-cue]").waitFor();
  assert.deepEqual(await cues(), [[`run-${runId}-assistant-1`, "mem-annie"]]);
  // The Memory workspace refetches what the turn changed.
  assert.deepEqual(
    await page.evaluate(() => window.fixture.memoryCachesInvalidated()),
    [true, true],
  );

  await page.evaluate((run_id) => {
    window.fixture.send(0, [{ run_id, chat_id: "chat-fixture" }]);
  }, runId);
  await sessionIdle(page);
  await page.waitForFunction(
    () => document.querySelector("#finalizing").textContent === "false",
  );
  // Streaming state is gone; the cached completion rows now carry the cue.
  assert.deepEqual(await cues(), [[`run-${runId}-assistant-1`, "mem-annie"]]);

  await page.evaluate(() => {
    window.fixture.setHistory("chat-other", [
      {
        id: 1,
        chat_id: "chat-other",
        run_id: "run-old",
        role: "user",
        content: "Remember my cat",
        created_at: "2026-09-01T00:00:00Z",
      },
      {
        id: 2,
        chat_id: "chat-other",
        run_id: "run-old",
        role: "assistant",
        content: "Persisted display",
        created_at: "2026-09-01T00:00:01Z",
        data: {
          structured: {
            speech: "Persisted speech",
            display: "Persisted display",
          },
        },
        memory_cue: { episode: { text: "Has a cat" }, memories: null },
      },
    ]);
    window.fixture.switchChat();
  });
  await page.getByText("Persisted display", { exact: true }).waitFor();
  assert.deepEqual(await cues(), [["run-run-old-assistant-1", "Has a cat"]]);
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  listReelItems,
  loadSoundCatalog,
  recordReel,
} from "./animation-reel.mjs";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

// A real recording: a looping Gesture without effects, then a Reaction with
// an Avatar Effect (and its sound), a Particle Effect and a Scene Effect.
test(
  "records a reel with chapters and the sounds clip events play",
  { skip: !hasFfmpeg && "ffmpeg is not installed" },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "animama-reel-"));
    try {
      // eye_vv names builtin:sound-effect:cute_chirpy_03 as its sound.
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:duration=0.5",
        path.join(dir, "cute_chirpy_03.wav"),
      ]);
      await writeFile(
        path.join(dir, "cute_chirpy_03.meta.json"),
        JSON.stringify({
          content_type: "sound_effect",
          content_id: "builtin:sound-effect:cute_chirpy_03",
          name: "Test Chirp",
          duration_seconds: 0.5,
        }),
      );
      const items = await listReelItems({
        gestures: false,
        reactions: false,
        sources: [
          "library:gesture/arms-crossed",
          "library:reaction/amusement-3",
        ],
        cwd: process.cwd(),
        localContent: null,
      });
      const out = path.join(dir, "reel.mp4");
      const { results, duration, soundCount } = await recordReel({
        items,
        out,
        avatar: "AvatarSample_A_1_New",
        camera: "portrait",
        size: { width: 640, height: 360 },
        fps: 10,
        lead: 0.2,
        tail: 0.2,
        talk: 0.5,
        maxSec: 20,
        crf: 30,
        catalog: await loadSoundCatalog([dir]),
        localContent: null,
        software: true,
        log: () => undefined,
      });

      assert.deepEqual(
        results.map(({ stem, failure, warnings }) => ({
          stem,
          failure,
          warnings,
        })),
        [
          { stem: "arms-crossed", failure: null, warnings: [] },
          { stem: "amusement-3", failure: null, warnings: [] },
        ],
      );
      assert.equal(soundCount, 1);
      const probe = JSON.parse(
        execFileSync("ffprobe", [
          "-v",
          "error",
          "-show_streams",
          "-show_chapters",
          "-show_format",
          "-of",
          "json",
          out,
        ]),
      );
      const video = probe.streams.find((s) => s.codec_type === "video");
      const audio = probe.streams.find((s) => s.codec_type === "audio");
      assert.equal(video.codec_name, "h264");
      assert.equal(`${video.width}x${video.height}`, "640x360");
      assert.equal(audio.codec_name, "aac");
      assert.ok(Math.abs(Number(probe.format.duration) - duration) < 0.2);
      assert.deepEqual(
        probe.chapters.map((chapter) => chapter.tags.title),
        [
          "Gesture · 1 / 2 · Arms Crossed",
          "Reaction · 2 / 2 · Amusement Reaction 3 (Amusement · intensity 3)",
        ],
      );
      // The test tone (lavfi's default amplitude, about -21 dB) is mixed in
      // during the Reaction only; the rest is the silent base track.
      const maxVolume = ({ start, end }) => {
        const { stderr } = spawnSync(
          "ffmpeg",
          [
            "-hide_banner",
            "-ss",
            String(start),
            "-t",
            String(end - start),
            "-i",
            out,
            "-vn",
            "-af",
            "volumedetect",
            "-f",
            "null",
            "-",
          ],
          { encoding: "utf8" },
        );
        return Number(/max_volume: (-?[\d.]+) dB/.exec(stderr)?.[1]);
      };
      assert.ok(maxVolume(results[0]) < -60);
      assert.ok(maxVolume(results[1]) > -30);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  processGuardPath,
  runtimePlatform,
} from "../../src/main-process/runtime/manifest.js";
import { runtimePaths } from "../../src/main-process/runtime/paths.js";
import { PrivatePostgres } from "../../src/main-process/runtime/postgres.js";
import {
  OwnedProcesses,
  runCommand,
  useProcessGuard,
} from "../../src/main-process/runtime/processes.js";
import { databaseSchemaDigest } from "../../src/main-process/runtime/schema.js";

/**
 * Create a disposable profile database the same way a fresh launch does, using
 * the staged PostgreSQL, the frozen backend and the supervisor's own helpers,
 * and return its schema digest. No developer database or profile is touched.
 */
export async function stagedSchemaDigest(runtimeRoot: string): Promise<string> {
  const base = mkdtempSync(
    path.join(realpathSync(tmpdir()), "animama-schema-profile-"),
  );
  const paths = runtimePaths(base);
  // The stage builds the guard before this step, as a launch would find it.
  const guard = processGuardPath(process.platform);
  if (guard) useProcessGuard(path.join(runtimeRoot, guard));
  const owned = new OwnedProcesses(paths.processes);
  const postgres = new PrivatePostgres(runtimeRoot, paths, owned);
  try {
    const env = await postgres.start(randomBytes(32).toString("hex"));
    const backend = path.join(
      runtimeRoot,
      `backend/animama-runtime${runtimePlatform(process.platform).executableSuffix}`,
    );
    for (const operation of ["provision", "bootstrap"])
      await runCommand(
        backend,
        ["database", operation],
        {
          ...env,
          ANIMAMA_DESKTOP_PGDATA: paths.pgData,
          ANIMAMA_LOG_TO_FILE: "0",
          ANIMAMA_LOG_TO_CONSOLE: "0",
        },
        base,
      );
    return await databaseSchemaDigest(postgres.bin("pg_dump"), env, base);
  } finally {
    try {
      await postgres.stop();
    } finally {
      await owned.terminateAll();
      rmSync(base, { recursive: true, force: true });
    }
  }
}

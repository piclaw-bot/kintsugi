// Preloaded by every `bun test` run (see bunfig.toml) so tests, and the processes they
// spawn, never read or write the real host data directory.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "kintsugi-test-data-"));
process.env.ATELIER_DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

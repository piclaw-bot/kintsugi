import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStorageDriver, storageContainerdConfig, assertStorageSupport } from "./storage-driver.ts";

test("storage selection defaults only when absent and rejects malformed settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kintsugi-storage-"));
  const path = join(directory, "storage.json");
  try {
    expect(await readStorageDriver(path)).toBe("erofs");
    for (const driver of ["erofs", "overlayfs"] as const) {
      await writeFile(path, JSON.stringify({ driver }));
      expect(await readStorageDriver(path)).toBe(driver);
    }
    for (const text of ["{", "null", "[]", "{}", '{"driver":"overlay2"}', '{"driver":"overlayfs","extra":true}']) {
      await writeFile(path, text);
      await expect(readStorageDriver(path)).rejects.toThrow();
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("overlayfs selects the ordinary differ and rejects unfamiliar runtime configuration", () => {
  const config = 'default = ["erofs", "walking"]\n';
  expect(storageContainerdConfig(config, "erofs")).toBe(config);
  expect(storageContainerdConfig(config, "overlayfs")).toBe('default = ["walking"]\n');
  expect(() => storageContainerdConfig("unknown", "overlayfs")).toThrow();
});

test("old images remain usable with erofs but cannot run in compatibility mode", () => {
  assertStorageSupport({}, "erofs");
  expect(() => assertStorageSupport({}, "overlayfs")).toThrow("does not support overlayfs");
  assertStorageSupport({ "kintsugi.storage-drivers": "erofs,overlayfs" }, "overlayfs");
});

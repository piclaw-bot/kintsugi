import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isNotFoundError } from "./fs.ts";

const driverSchema = Type.Union([Type.Literal("erofs"), Type.Literal("overlayfs")]);
export type StorageDriver = "erofs" | "overlayfs";
export const storageDriversLabel = "kintsugi.storage-drivers";

/** Missing settings retain the original EROFS installation behaviour. */
export async function readStorageDriver(path = "/etc/kintsugi/storage.json"): Promise<StorageDriver> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if (isNotFoundError(error)) return "erofs"; throw error; }
  return Value.Parse(Type.Object({ driver: driverSchema }, { additionalProperties: false }), JSON.parse(text)).driver;
}

export function storageContainerdConfig(config: string, driver: StorageDriver): string {
  if (driver === "erofs") return config;
  if (!config.includes('default = ["erofs", "walking"]')) throw new Error("Unsupported containerd differ configuration");
  return config.replace('default = ["erofs", "walking"]', 'default = ["walking"]');
}

export function assertStorageSupport(labels: Record<string, string> | null | undefined, driver: StorageDriver): void {
  // Older releases support the original storage mode only.
  if (driver === "overlayfs" && !labels?.[storageDriversLabel]?.split(",").includes(driver)) throw new Error("Image does not support overlayfs storage; existing services were retained");
}

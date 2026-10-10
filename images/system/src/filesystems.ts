import type { StorageDriver } from "../../../packages/core/src/storage-driver.ts";

// Containers share Docker's host kernel, including when that host is a VM.
export function filesystemFailure(filesystems: string, driver: StorageDriver = "erofs"): string | undefined {
  const available = new Set(filesystems.trim().split(/\s+/));
  const missing = (driver === "erofs" ? ["erofs", "overlay"] : ["overlay"]).filter((name) => !available.has(name));
  if (!missing.length) return;
  return `The Linux kernel that powers your Docker does not have ${missing.join(", ")}, which Kintsugi requires.`;
}

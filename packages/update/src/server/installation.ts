import { Type } from "typebox";
import { Value } from "typebox/value";
import { installationUpdateSchema, type InstallationUpdate } from "@kintsugi/shared/installation-update";
import type { HttpFetcher } from "./registry.ts";

export interface InstallationClient {
  installed(): Promise<boolean>;
  status(): Promise<InstallationUpdate>;
  check(): Promise<InstallationUpdate>;
  prepare(id: string): Promise<InstallationUpdate>;
  apply(id: string): Promise<InstallationUpdate>;
  rollback(): Promise<InstallationUpdate>;
}
export function createInstallationClient(fetcher: HttpFetcher = fetch): InstallationClient {
  async function request(operation: string, id?: string): Promise<InstallationUpdate> {
    const response = await fetcher(`http://127.0.0.1:3001/release/updater/${operation}`, operation === "status" ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(id ? { id } : {}) });
    if (!response.ok) throw Error("Host updater could not complete this operation. Check installation status or host diagnostics.");
    return Value.Parse(installationUpdateSchema, await response.json());
  }
  return {
    async installed() { const response = await fetcher("http://127.0.0.1:3001/release/updater/capabilities"); if (response.status === 404) return false; if (!response.ok) throw Error("Cannot determine host updater availability"); return Value.Parse(Type.Object({ installed: Type.Boolean(), available: Type.Boolean() }), await response.json()).installed; },
    status: () => request("status"), check: () => request("check"), prepare: id => request("prepare", id), apply: id => request("apply", id), rollback: () => request("rollback"),
  };
}

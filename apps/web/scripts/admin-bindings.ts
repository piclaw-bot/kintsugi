import { getKintsugiRuntimeContext, isJsonObject } from "@kintsugi/core";
import { createSecureContext } from "node:tls";
import { open, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createAdminStore, publicToken, validateAdminBootstrap } from "../src/server/admin/store.ts";

export async function adminBindingsCommand(args: string[]) {
  if (existsSync("/run/kintsugi-system/access-v1") && process.getuid?.() !== 1000) throw new Error("Run the admin CLI as UID/GID 1000:1000 in the System app container to avoid unreadable root-owned configuration");
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { "data-dir": { type: "string" }, file: { type: "string" }, "token-output": { type: "string" }, check: { type: "boolean" } } });
  const [command, id] = positionals;
  if (positionals.length > (command === "revoke" ? 2 : 1)) throw new Error("Unexpected arguments");
  const store = createAdminStore(join(values["data-dir"] ?? getKintsugiRuntimeContext().kintsugiDataDir, "admin-bindings.json"));
  switch (command) {
    case "show": { const config = await store.read(); return { bindings: config.bindings, tokens: config.tokens.map(publicToken) }; }
    case "configure": {
      if (!values.file) throw new Error("configure requires --file with JSON { bindings: [...] }; app restart required");
      const input = await Bun.file(values.file).json();
      if (!isJsonObject(input) || Object.keys(input).length !== 1 || !("bindings" in input)) throw new Error("Expected { bindings: [...] }");
      return store.setBindings(input.bindings);
    }
    case "bootstrap": {
      if (!values.file) throw new Error("bootstrap requires --file; use --check to validate without writing");
      const input = validateAdminBootstrap(await Bun.file(values.file).json());
      for (const binding of input.bindings) {
        if (!binding.tls) continue;
        if ((await stat(binding.tls.key)).mode & 0o077) throw new Error("TLS private key must not be readable by group or others");
        createSecureContext({ cert: await readFile(binding.tls.cert), key: await readFile(binding.tls.key) });
      }
      if (values.check) return { valid: true };
      const output = values["token-output"];
      if (!output) throw new Error("bootstrap requires --token-output FILE or - for secure stdout/keychain capture");
      return store.bootstrap(input, async issued => {
        const text = JSON.stringify(issued) + "\n";
        if (output === "-") {
          await new Promise<void>((resolve, reject) => process.stdout.write(text, error => error ? reject(error) : resolve()));
          return async () => {}; // Failed commit leaves the delivered token inactive.
        }
        const file = await open(output, "wx", 0o600);
        try { await file.writeFile(text); await file.sync(); }
        catch (error) { await file.close(); await rm(output); throw error; }
        await file.close();
        return async () => { await rm(output); };
      });
    }
    case "issue": {
      if (!values.file) throw new Error("issue requires --file with JSON { name, scopes, expiresAt? }");
      return store.issue(await Bun.file(values.file).json());
    }
    case "revoke": {
      if (!id) throw new Error("revoke requires a token ID");
      if (!await store.revoke(id)) throw new Error("Token not found");
      return { revoked: true };
    }
    default: throw new Error("Usage: bun apps/web/scripts/admin-bindings.ts show|configure|bootstrap|issue|revoke [token-id] [--file INPUT.json] [--data-dir PATH]. Configure/issue take JSON files. Issue prints the bearer secret once; capture it securely.");
  }
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const result = JSON.stringify(await adminBindingsCommand(args), null, 2);
    if (args[0] === "bootstrap" && args.includes("--token-output") && args[args.indexOf("--token-output") + 1] === "-") console.error(result);
    else console.log(result);
  }
  catch (error) { console.error(error instanceof Error ? error.message : "Admin configuration failed"); process.exitCode = 1; }
}

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getKintsugiRuntimeContext } from "./runtime-context.ts";

// Submodule URLs are repository-controlled, so never offer the GitHub token to another host.
export const gitHubCredentialHelperShellBody = `test "$1" = get || exit 0
protocol=
host=
while IFS='=' read -r key value; do
  case "$key" in
    protocol) protocol="$value" ;;
    host) host="$value" ;;
  esac
done
[ "$protocol" = https ] || exit 0
case "$host" in github.com|github.com:443) ;; *) exit 0 ;; esac
[ -n "\${GH_TOKEN:-}" ] || exit 0
echo username=x-access-token
echo password="$GH_TOKEN"`;

export const gitHubCredentialHelperCommand = `!f() { ${gitHubCredentialHelperShellBody}; }; f`;

// Keep the existing credential paths so older installations retain their GitHub connection.
function storedGitHubTokenPath(): string {
  return join(getKintsugiRuntimeContext().kintsugiDataDir, "workspace", "github-token");
}

function disabledHostGitHubTokenPath(): string {
  return join(getKintsugiRuntimeContext().kintsugiDataDir, "workspace", "github-token-disabled");
}

export function discoverGitHubToken(): string | undefined {
  const path = storedGitHubTokenPath();
  const stored = existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
  if (stored) return stored;
  if (existsSync(disabledHostGitHubTokenPath())) return undefined;
  return process.env.GH_TOKEN?.trim() || undefined;
}

export function hasGitHubToken(): boolean {
  return Boolean(discoverGitHubToken());
}

export function setGitHubToken(token: string): void {
  const path = storedGitHubTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token.trim()}\n`, { mode: 0o600 });
  rmSync(disabledHostGitHubTokenPath(), { force: true });
}

export function clearGitHubToken(): void {
  const disabledPath = disabledHostGitHubTokenPath();
  rmSync(storedGitHubTokenPath(), { force: true });
  mkdirSync(dirname(disabledPath), { recursive: true });
  writeFileSync(disabledPath, "", { mode: 0o600 });
}

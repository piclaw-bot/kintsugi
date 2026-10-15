import { discoverGitHubToken, setGitHubToken, clearGitHubToken, type GitHostingProvider } from "@kintsugi/core";
import { validateGitHubToken } from "./auth.ts";
import { gitHubKnownHosts } from "./host-keys.ts";
import { searchGitHubRepositories } from "./repository-search.ts";

export const gitHubProvider: GitHostingProvider = {
  id: "github",
  label: "GitHub",
  gitHost: "github.com",
  gitUsername: "x-access-token",
  tokenEnvVar: "GH_TOKEN",
  tokenEnvAliases: [],
  tokenHosts: ["github.com", "api.github.com"],
  sshKnownHosts: gitHubKnownHosts,
  connectForm: {
    instructionsHtml: `<p>Run these commands on your own computer:</p>
    <pre class="settings-command">gh auth login
gh auth token</pre>
    <p>Paste the token below.</p>`,
    tokenPlaceholder: "Paste output from gh auth token",
  },
  credential() {
    const token = discoverGitHubToken();
    return token ? { token } : undefined;
  },
  saveCredential(credential) {
    setGitHubToken(credential.token);
  },
  clearCredential() {
    clearGitHubToken();
  },
  workspaceEnv: () => ({}),
  validateCredential: (credential) => validateGitHubToken(credential.token),
  searchRepositories: (query, credential) => searchGitHubRepositories(query, credential?.token),
};

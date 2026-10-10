import { KintsugiCoreError } from "@kintsugi/core";
import { jsonResponse } from "@kintsugi/shared/http";

export function httpErrorStatus(error: Error): number {
  return error instanceof KintsugiCoreError && ["invalid_arguments", "invalid_git_url", "terminal_invalid_cwd"].includes(error.code) ? 400
    : error instanceof KintsugiCoreError && ["repo_not_found", "workspace_template_not_found", "workspace_template_environment_variable_not_found", "workspace_template_secret_not_found", "workspace_not_found", "command_not_found", "agent_not_found", "view_not_found", "terminal_not_found"].includes(error.code) ? 404
      : error instanceof KintsugiCoreError && ["agent_setup_required", "last_agent", "workspace_not_ready", "workspace_template_secret_routing_changed", "workspace_template_settings_conflict"].includes(error.code) ? 409
        : 500;
}

export function problemJsonResponse(error: Error): Response {
  const status = httpErrorStatus(error);
  const code = error instanceof KintsugiCoreError ? error.code : "internal_error";
  const details = error instanceof KintsugiCoreError ? error.details : undefined;
  return jsonResponse({ error: { code, message: error.message, ...(details ?? {}) } }, { status });
}

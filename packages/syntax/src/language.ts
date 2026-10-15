import { shaderLanguageFromExtension } from "./shader-languages.ts";

const extensionLanguages = new Map(Object.entries({
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  html: "html", htm: "html", erb: "erb", rhtml: "erb", xml: "xml", svg: "xml", css: "css", scss: "scss", cs: "csharp", csx: "csharp",
  json: "json", jsonc: "jsonc", yaml: "yaml", yml: "yaml", md: "markdown", markdown: "markdown", sh: "bash", bash: "bash", zsh: "bash",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", regex: "regex", sql: "sql", dockerfile: "docker",
  vue: "vue", svelte: "svelte", astro: "astro", tf: "terraform", tfvars: "terraform", hcl: "hcl", php: "php", phtml: "php", proto: "proto",
}));
/** Filename-based language detection shared by server highlighting and browser exports. */
export function languageFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
  if (basename === "dockerfile") return "docker";
  const dot = basename.lastIndexOf(".");
  const extension = dot > 0 ? basename.slice(dot + 1) : "";
  return extensionLanguages.get(extension) ?? shaderLanguageFromExtension(extension);
}

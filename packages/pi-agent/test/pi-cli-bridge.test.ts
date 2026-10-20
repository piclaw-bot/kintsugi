import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelsError, type Api, type AuthResult, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createHttpHooks } from "../../proxy-egress/src/secrets/placeholder-hooks.ts";
import { createPiCliConfiguration, createPiCliCredentialTransform, piCliCredentialHosts, piCliModelUnavailableReason } from "../src/server/pi-cli-bridge.ts";

function model(provider: string, api: Api = "openai-completions", baseUrl = `https://${provider}.example/v1`): Model<Api> {
  return { provider, id: "test-model", name: "Test model", api, baseUrl, reasoning: true, input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000, thinkingLevelMap: { minimal: null } };
}
function fixture(models: Model<Api>[], auth: Record<string, AuthResult>) {
  return {
    models, auth,
    getProviders: () => [...new Set(models.map(model => model.provider))].map(id => ({ id })),
    getAvailable: async (provider?: string) => models.filter((m) => (!provider || m.provider === provider) && auth[m.provider]),
    getAvailableOfType: async () => [],
    getModelOfType: () => undefined,
    checkAuth: async (provider: string) => auth[provider] ? { type: auth[provider]!.source === "OAuth" ? "oauth" as const : "api_key" as const } : undefined,
    getModel: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    getAuth: async (ref: Model<Api>) => auth[ref.provider],
  };
}
for (const failure of ["catalogue", "credentials"] as const) {
  test(`expired Claude OAuth during ${failure} does not block Pi configuration or connections`, async () => {
    const runtime = fixture([model("custom"), model("anthropic", "anthropic-messages")], {
      custom: { auth: { apiKey: "healthy-key" } },
      anthropic: { source: "OAuth", auth: { apiKey: "sk-ant-oat-expired" } },
    });
    const getAvailable = runtime.getAvailable;
    const getAuth = runtime.getAuth;
    let rejected = false;
    runtime.getAvailable = async provider => {
      if (rejected && failure === "catalogue" && (!provider || provider === "anthropic")) throw new ModelsError("oauth", "invalid_grant");
      return getAvailable(provider);
    };
    runtime.getAuth = async ref => {
      if (rejected && ref.provider === "anthropic") throw new ModelsError("oauth", "invalid_grant");
      return getAuth(ref);
    };
    const enabled = [{ provider: "custom", id: "test-model", label: "Custom" }];
    const before = await createPiCliConfiguration(runtime, enabled);
    rejected = true;
    const config = await createPiCliConfiguration(runtime, enabled);
    expect(config.enabledModels).toEqual(["custom/test-model"]);
    expect(config.auth).toEqual(before.auth);
    expect(await piCliCredentialHosts(runtime)).toEqual(["custom.example"]);
    const transform = createPiCliCredentialTransform(async () => runtime);
    const request = await transform(new Request("https://custom.example/v1", { headers: { authorization: `Bearer ${before.auth.custom!.key}` } }), () => {});
    expect(request.headers.get("authorization")).toBe("Bearer healthy-key");
    await expect(piCliModelUnavailableReason(runtime, { provider: "anthropic", id: "test-model" })).rejects.toThrow("invalid_grant");
  });
}

test("unexpected provider errors still fail Pi configuration and host discovery", async () => {
  const runtime = fixture([model("custom")], { custom: { auth: { apiKey: "key" } } });
  runtime.getAuth = async () => { throw new Error("unexpected failure"); };
  await expect(createPiCliConfiguration(runtime, [])).rejects.toThrow("unexpected failure");
  await expect(piCliCredentialHosts(runtime)).rejects.toThrow("unexpected failure");
});

function jwt(account: string) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.real-signature`;
}

test("exports enabled models, labels, capabilities and custom models without credentials or raw auth configuration", async () => {
  const models = [model("custom"), model("openai-codex", "openai-codex-responses", "https://chatgpt.com/backend-api"), model("anthropic", "anthropic-messages", "https://api.anthropic.com")];
  const runtime = fixture(models, {
    custom: { auth: { apiKey: "custom-secret", headers: { "x-custom-auth": "custom-header-secret" } } },
    "openai-codex": { auth: { apiKey: jwt("real-account") }, source: "OAuth" },
    anthropic: { auth: { apiKey: "sk-ant-oat-real-secret" }, source: "OAuth" },
  });
  const config = await createPiCliConfiguration(runtime, [{ provider: "custom", id: "test-model", label: "My enabled model" }, { provider: "anthropic", id: "test-model", label: "Claude" }]);
  // Anthropic permits Claude subscription tokens only in Claude Code.
  expect(config.enabledModels).toEqual(["custom/test-model"]);
  expect(config.auth.anthropic).toBeUndefined();
  expect(config.models.providers.custom!.models[0]!.name).toBe("My enabled model");
  expect(config.models.providers.custom!.models[0]!.thinkingLevelMap).toEqual({ minimal: null });
  const serialized = JSON.stringify(config);
  for (const secret of ["custom-secret", "custom-header-secret", "real-account", "real-signature", "sk-ant-oat-real-secret", "refresh"]) expect(serialized).not.toContain(secret);

  // These files must actually load through the same Pi runtime used by the CLI.
  const directory = await mkdtemp(join(tmpdir(), "pi-bridge-"));
  try {
    await writeFile(join(directory, "models.json"), JSON.stringify(config.models));
    await writeFile(join(directory, "auth.json"), JSON.stringify(config.auth));
    const imported = await ModelRuntime.create({ modelsPath: join(directory, "models.json"), authPath: join(directory, "auth.json"), modelsStorePath: join(directory, "cache.json"), allowModelNetwork: false });
    expect(imported.getError()).toBeUndefined();
    const available = await imported.getAvailable();
    for (const m of models.filter((item) => item.provider !== "anthropic")) expect(available.some((item) => item.provider === m.provider && item.id === m.id)).toBe(true);
    expect((await imported.getAuth(imported.getModel("custom", "test-model")!))!.auth.headers!["x-custom-auth"]).toBe(config.models.providers.custom!.models[0]!.headers!["x-custom-auth"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("resolves fresh credentials on each request and works with a newly created bridge after restart", async () => {
  const runtime = fixture([model("custom")], { custom: { auth: { apiKey: "first-key", headers: { "x-key": "first-header" } } } });
  const config = await createPiCliConfiguration(runtime, []);
  const headers = { Authorization: `Bearer ${config.auth.custom!.key}`, ...config.models.providers.custom!.models[0]!.headers };
  for (const version of ["first", "refreshed"]) {
    runtime.auth.custom = { auth: { apiKey: `${version}-key`, headers: { "x-key": `${version}-header` } } };
    const transform = createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest;
    const request = await transform(new Request("https://custom.example/v1/chat/completions", { method: "POST", headers, body: '{"messages":[]}' }));
    expect(request.headers.get("authorization")).toBe(`Bearer ${version}-key`);
    expect(request.headers.get("x-key")).toBe(`${version}-header`);
    expect(await request.text()).toBe('{"messages":[]}');
  }
});

test("Codex receives a real access token and account header while the CLI gets only a synthetic JWT", async () => {
  const runtime = fixture([model("openai-codex", "openai-codex-responses", "https://chatgpt.com/backend-api")], { "openai-codex": { auth: { apiKey: jwt("account-one") }, source: "OAuth" } });
  const config = await createPiCliConfiguration(runtime, []);
  const key = config.auth["openai-codex"]!.key;
  const claims = JSON.parse(Buffer.from(key.split(".")[1]!, "base64url").toString());
  runtime.auth["openai-codex"]!.auth.apiKey = jwt("account-two");
  const request = await createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest(new Request("https://chatgpt.com/backend-api/codex/responses", { headers: { authorization: `Bearer ${key}`, "chatgpt-account-id": claims["https://api.openai.com/auth"].chatgpt_account_id } }));
  expect(request.headers.get("authorization")).toBe(`Bearer ${jwt("account-two")}`);
  expect(request.headers.get("chatgpt-account-id")).toBe("account-two");
});

test("OpenAI placeholders keep the shape Pi uses to tell API keys from Sign in with ChatGPT", async () => {
  const openai = { ...model("openai", "openai-responses", "https://api.openai.com/v1"), maxTokens: 4000 };
  // Pi omits request fields that Sign in with ChatGPT rejects, based on whether the key starts with `sk-`.
  async function cliRequestOmitsMaxOutputTokens(key: string): Promise<boolean> {
    let omitted: boolean | undefined;
    await streamOpenAIResponses({ ...openai, api: "openai-responses" }, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {
      apiKey: key, maxTokens: 2000,
      onPayload(body) {
        omitted = Value.Parse(Type.Object({ max_output_tokens: Type.Optional(Type.Number()) }), body).max_output_tokens === undefined;
        throw new Error("Stop after serialization; no network request");
      },
    }).result();
    return omitted!;
  }
  for (const [secret, subscription] of [["sk-proj-real-secret", false], ["chatgpt-access-token", true]] as const) {
    const runtime = fixture([openai], { openai: { auth: { apiKey: secret } } });
    const key = (await createPiCliConfiguration(runtime, [])).auth.openai!.key;
    expect(key).not.toContain(secret);
    expect(await cliRequestOmitsMaxOutputTokens(key)).toBe(subscription);
    const request = await createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest(new Request("https://api.openai.com/v1/responses", { headers: { authorization: `Bearer ${key}` } }));
    expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
  }
});

test("exports Anthropic API keys but refuses Claude subscription tokens, including for already running Pi tabs", async () => {
  const anthropic = model("anthropic", "anthropic-messages", "https://api.anthropic.com");
  const runtime = fixture([anthropic], { anthropic: { auth: { apiKey: "sk-ant-api03-secret" } } });
  expect(await piCliModelUnavailableReason(runtime, anthropic)).toBeUndefined();
  const config = await createPiCliConfiguration(runtime, []);
  const transform = createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest;
  const request = () => new Request("https://api.anthropic.com/v1/messages", { headers: { "x-api-key": config.auth.anthropic!.key } });
  expect((await transform(request())).headers.get("x-api-key")).toBe("sk-ant-api03-secret");

  runtime.auth.anthropic = { auth: { apiKey: "sk-ant-oat01-secret" } };
  expect(await piCliModelUnavailableReason(runtime, anthropic)).toContain("Anthropic does not allow you to use our other agents with their subscription");
  expect((await createPiCliConfiguration(runtime, [])).auth.anthropic).toBeUndefined();
  await expect(transform(request())).rejects.toThrow("Anthropic does not allow you to use our other agents with their subscription");
});

test("rejects foreign hosts, changed endpoints, disconnected providers and malformed markers", async () => {
  const runtime = fixture([model("custom")], { custom: { auth: { apiKey: "secret" } } });
  const config = await createPiCliConfiguration(runtime, []);
  const transform = createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest;
  const request = (url: string) => new Request(url, { headers: { authorization: `Bearer ${config.auth.custom!.key}` } });
  for (const url of ["https://attacker.example/", "http://custom.example/", "https://custom.example:444/"]) await expect(transform(request(url))).rejects.toThrow("not allowed");
  runtime.models[0]!.baseUrl = "https://changed.example/v1";
  await expect(transform(request("https://custom.example/v1"))).rejects.toThrow("not allowed");
  delete runtime.auth.custom;
  await expect(transform(request("https://changed.example/v1"))).rejects.toThrow("no longer connected");
  await expect(transform(new Request("https://custom.example/", { headers: { authorization: "kintsugi-pi-e30-end" } }))).rejects.toThrow("Invalid Pi credential placeholder");
});

test("supports query API keys without changing unrelated query semantics", async () => {
  const runtime = fixture([model("google", "google-generative-ai", "https://generativelanguage.googleapis.com/v1beta")], { google: { auth: { apiKey: "secret+/=&" } } });
  const config = await createPiCliConfiguration(runtime, []);
  const transform = createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest;
  const request = await transform(new Request(`https://generativelanguage.googleapis.com/v1beta/models?key=${config.auth.google!.key}&alt=sse`));
  expect(new URL(request.url).searchParams.get("key")).toBe("secret+/=&");
  expect(new URL(request.url).searchParams.get("alt")).toBe("sse");
  await expect(transform(new Request(`https://attacker.example/?key=${config.auth.google!.key}`))).rejects.toThrow("not allowed");
});

test("materializes Cloudflare endpoint parameters and header-only credentials without copying env or secrets", async () => {
  const runtime = fixture([model("cloudflare-ai-gateway", "openai-completions", "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat")], {
    "cloudflare-ai-gateway": { auth: { headers: { "cf-aig-authorization": "Bearer cf-secret", Authorization: null, "x-api-key": null } }, env: { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_GATEWAY_ID: "gateway" } },
  });
  const config = await createPiCliConfiguration(runtime, []);
  const exported = config.models.providers["cloudflare-ai-gateway"]!.models[0]!;
  expect(exported.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/account/gateway/compat");
  expect(JSON.stringify(config)).not.toContain("cf-secret");
  const request = await createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest(new Request(`${exported.baseUrl}/chat/completions`, { headers: exported.headers }));
  expect(request.headers.get("cf-aig-authorization")).toBe("Bearer cf-secret");
  expect(request.headers.has("authorization")).toBe(false);
  expect(request.headers.has("x-api-key")).toBe(false);
});

test("refuses host-only credential chains, but supports Bedrock bearer tokens and Vertex API keys", async () => {
  const models = [model("amazon-bedrock", "bedrock-converse-stream", "https://bedrock-runtime.us-east-1.amazonaws.com"), model("google-vertex", "google-vertex", "https://{location}-aiplatform.googleapis.com")];
  const runtime = fixture(models, { "amazon-bedrock": { auth: {}, env: { AWS_PROFILE: "secret-profile" } }, "google-vertex": { auth: {}, env: { GOOGLE_APPLICATION_CREDENTIALS: "/host/secret.json" } } });
  for (const m of models) expect(await piCliModelUnavailableReason(runtime, m)).toContain("requires an API key or bearer token");
  expect((await createPiCliConfiguration(runtime, [])).models.providers).toEqual({});
  runtime.auth["amazon-bedrock"] = { auth: { apiKey: "bedrock-token" } };
  runtime.auth["google-vertex"] = { auth: { apiKey: "vertex-key" } };
  const config = await createPiCliConfiguration(runtime, []);
  expect(config.models.providers["google-vertex"]!.models[0]!.baseUrl).toBe("https://aiplatform.googleapis.com");
  const request = await createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest(new Request("https://aiplatform.googleapis.com/v1/publishers/google/models/model:streamGenerateContent", { headers: { "x-goog-api-key": config.auth["google-vertex"]!.key } }));
  expect(request.headers.get("x-goog-api-key")).toBe("vertex-key");
});

test("rejects embedded URL credentials instead of copying them into the workspace", async () => {
  const runtime = fixture([model("custom", "openai-completions", "https://user:secret@custom.example/v1")], { custom: { auth: { apiKey: "secret" } } });
  await expect(createPiCliConfiguration(runtime, [])).rejects.toThrow("without embedded credentials");
});

test("credential bridge intercepts current model hosts and authentication endpoint overrides", async () => {
  const runtime = fixture([
    model("openai", "openai-responses", "https://api.openai.com/v1"),
    model("custom"),
    model("anthropic", "anthropic-messages", "https://api.anthropic.com"),
  ], {
    openai: { auth: { apiKey: "access-token", baseUrl: "https://chatgpt.com/backend-api" } },
    custom: { auth: { apiKey: "secret" } },
    anthropic: { auth: { apiKey: "sk-ant-oat-secret" } },
  });
  expect(await piCliCredentialHosts(runtime)).toEqual(["chatgpt.com", "custom.example"]);
  runtime.auth.openai = { auth: { apiKey: "sk-secret" } };
  expect(await piCliCredentialHosts(runtime)).toEqual(["api.openai.com", "custom.example"]);
});

test("bridge credentials are scrubbed from reflected headers and queries, including after refresh", async () => {
  const runtime = fixture([model("custom")], { custom: { auth: { apiKey: "first-key+/=", headers: { "x-key": "first-header" } } } });
  const config = await createPiCliConfiguration(runtime, []);
  const hooks = createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks;
  const request = () => new Request(`https://custom.example/v1?key=${config.auth.custom!.key}`, {
    headers: { authorization: `Bearer ${config.auth.custom!.key}`, ...config.models.providers.custom!.models[0]!.headers },
  });
  const first = await hooks.onRequest(request());
  runtime.auth.custom = { auth: { apiKey: "refreshed-key+/=", headers: { "x-key": "refreshed-header" } } };
  const second = await hooks.onRequest(request());
  for (const outbound of [second, first]) {
    expect(hooks.scrubResponseHeader(outbound.url, outbound)).toBe("https://custom.example/v1?key=[REDACTED]");
    expect(hooks.scrubResponseHeader(outbound.headers.get("authorization")!, outbound)).toBe("Bearer [REDACTED]");
    expect(hooks.scrubResponseHeader(outbound.headers.get("x-key")!, outbound)).toBe("[REDACTED]");
  }
});

test("Pi cannot bypass path permissions by putting a bridge placeholder into a URL path", async () => {
  const runtime = fixture([model("custom")], { custom: { auth: { apiKey: "private-key" } } });
  const config = await createPiCliConfiguration(runtime, []);
  const hooks = createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks;
  await expect(hooks.onRequest(new Request(`https://custom.example/v1/${config.auth.custom!.key}`))).rejects.toThrow("cannot be injected into URL paths");
  // Disallowed path use also fails when a legitimate header accompanies it.
  await expect(hooks.onRequest(new Request(`https://custom.example/v1/${config.auth.custom!.key}`, {
    headers: { authorization: `Bearer ${config.auth.custom!.key}` },
  }))).rejects.toThrow("cannot be injected into URL paths");
});

test("bridge-supplied Basic authentication protects the encoded credential as well as the complete header", async () => {
  const encoded = Buffer.from("user:bridge-password").toString("base64");
  const runtime = fixture([model("custom")], { custom: { auth: { headers: { authorization: `Basic ${encoded}` } } } });
  const config = await createPiCliConfiguration(runtime, []);
  const hooks = createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks;
  const outbound = await hooks.onRequest(new Request("https://custom.example/v1", { headers: config.models.providers.custom!.models[0]!.headers }));
  expect(hooks.scrubResponseHeader(outbound.headers.get("authorization")!, outbound)).toBe("[REDACTED]");
  expect(hooks.scrubResponseHeader(encoded, outbound)).toBe("[REDACTED]");
});


test("TypeSafe classifiers reach Pi with bridged credentials, without becoming chat selections", async () => {
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  await runtime.setRuntimeApiKey("typesafe", "typesafe-secret");
  const config = await createPiCliConfiguration(runtime, []);
  expect(config.auth.typesafe!.key).toContain("kintsugi-pi-");
  expect(JSON.stringify(config)).not.toContain("typesafe-secret");
  expect(config.models.providers.typesafe).toBeUndefined();
  expect(config.enabledModels).toEqual([]);
  expect(await piCliCredentialHosts(runtime)).toContain("api.typesafe.ai");
  const transform = createHttpHooks({ onRequest: createPiCliCredentialTransform(async () => runtime) }).httpHooks.onRequest;
  const request = await transform(new Request("https://api.typesafe.ai/v1/systemone", { headers: { authorization: `Bearer ${config.auth.typesafe!.key}` } }));
  expect(request.headers.get("authorization")).toBe("Bearer typesafe-secret");
  await expect(transform(new Request("https://other.example/v1/systemone", { headers: { authorization: `Bearer ${config.auth.typesafe!.key}` } }))).rejects.toThrow("not allowed");
  const directory = await mkdtemp(join(tmpdir(), "pi-classifier-bridge-"));
  try {
    await writeFile(join(directory, "models.json"), JSON.stringify(config.models));
    await writeFile(join(directory, "auth.json"), JSON.stringify(config.auth));
    const imported = await ModelRuntime.create({ modelsPath: join(directory, "models.json"), authPath: join(directory, "auth.json"), modelsStorePath: join(directory, "cache.json"), allowModelNetwork: false });
    expect(imported.getError()).toBeUndefined();
    expect((await imported.getAvailableOfType("classifier", "typesafe")).map(m => m.id)).toContain("jev-latest");
    expect(await imported.getAvailable("typesafe")).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("classifier-only credentials stay available when another provider has expired OAuth", async () => {
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  await runtime.setRuntimeApiKey("typesafe", "classifier-secret");
  const available = runtime.getAvailable.bind(runtime);
  runtime.getAvailable = async provider => {
    if (provider === "anthropic") throw new ModelsError("oauth", "invalid_grant");
    return available(provider);
  };
  const config = await createPiCliConfiguration(runtime, []);
  expect(config.auth.typesafe!.key).toContain("kintsugi-pi-");
  expect(config.models.providers.typesafe).toBeUndefined();
  expect(await piCliCredentialHosts(runtime)).toContain("api.typesafe.ai");
  expect(JSON.stringify(config)).not.toContain("classifier-secret");
});

import { describe, expect, test } from "bun:test";
import { HttpRequestBlockedError } from "../../src/secrets/errors.ts";
import { createHttpHooks } from "../../src/secrets/placeholder-hooks.ts";
import { matchHostname } from "../../src/secrets/patterns.ts";
import { isInternalAddress } from "../../src/secrets/ip.ts";

function expectRequest(result: Request | Response | void): asserts result is Request {
  expect(result).toBeInstanceOf(Request);
}

describe("secret placeholder hooks", () => {
  test("creates placeholder env var, not real secret", () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"] } } });
    expect(hooks.env.GH_TOKEN).toMatch(/^KINTSUGI_SECRET_[0-9a-f]{48}$/);
    expect(hooks.env.GH_TOKEN).not.toBe("real-secret");
  });

  test("replaces bearer placeholder for allowed host", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["api.github.com"], placeholder: "KINTSUGI_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://api.github.com/user", { headers: { authorization: "Bearer KINTSUGI_SECRET_fake" } }));
    expectRequest(result);
    expect(result.headers.get("authorization")).toBe("Bearer real-secret");
  });

  test("blocks placeholder sent to disallowed host", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "KINTSUGI_SECRET_fake" } } });
    await expect(hooks.httpHooks.onRequest!(new Request("https://example.com", { headers: { authorization: "Bearer KINTSUGI_SECRET_fake" } }))).rejects.toBeInstanceOf(HttpRequestBlockedError);
  });

  test("preserves unrelated headers and request ownership during repeated secret injection", async () => {
    for (const allowInPath of [false, true]) {
      const hooks = createHttpHooks({ secrets: { TOKEN: { allowInPath, value: "real-secret", hosts: ["example.com"], placeholder: "KINTSUGI_SECRET_fake" } } });
      for (let attempt = 0; attempt < 2; attempt++) {
        const request = new Request("https://example.com/KINTSUGI_SECRET_fake", {
          headers: { authorization: "Bearer KINTSUGI_SECRET_fake", "x-request-id": String(attempt) },
        });
        const result = await hooks.httpHooks.onRequest(request);
        expect(result === request).toBe(!allowInPath);
        expect(result.headers.get("authorization")).toBe("Bearer real-secret");
        expect(result.headers.get("x-request-id")).toBe(String(attempt));
        expect(request.headers.get("authorization")).toBe(allowInPath ? "Bearer KINTSUGI_SECRET_fake" : "Bearer real-secret");
      }
    }
  });

  test("replaces Basic auth password placeholders", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "KINTSUGI_SECRET_fake" } } });
    const basic = Buffer.from("x-access-token:KINTSUGI_SECRET_fake").toString("base64");
    const result = await hooks.httpHooks.onRequest!(new Request("https://github.com/repo.git", { headers: { authorization: `Basic ${basic}` } }));
    expectRequest(result);
    expect(result.headers.get("authorization")).toBe(`Basic ${Buffer.from("x-access-token:real-secret").toString("base64")}`);
  });

  test("does not replace request body", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "KINTSUGI_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://github.com", { method: "POST", body: "KINTSUGI_SECRET_fake" }));
    expectRequest(result);
    expect(await result.text()).toBe("KINTSUGI_SECRET_fake");
  });

  test("does not replace URL path by default", async () => {
    const hooks = createHttpHooks({ secrets: { API_TOKEN: { value: "123:secret", hosts: ["api.example.com"], placeholder: "KINTSUGI_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://api.example.com/botKINTSUGI_SECRET_fake/getMe"));
    expectRequest(result);
    expect(result.url).toBe("https://api.example.com/botKINTSUGI_SECRET_fake/getMe");
  });

  test("optionally replaces a URL path placeholder for an allowed host", async () => {
    const hooks = createHttpHooks({ secrets: { API_TOKEN: { allowInPath: true, value: "123:secret", hosts: ["api.example.com"], placeholder: "KINTSUGI_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://api.example.com/botKINTSUGI_SECRET_fake/getMe"));
    expectRequest(result);
    expect(result.url).toBe("https://api.example.com/bot123:secret/getMe");
  });

  test("one secret's path permission does not enable another secret on the same host", async () => {
    const { httpHooks } = createHttpHooks({ secrets: {
      A: { value: "allowed", hosts: ["example.com"], placeholder: "PLACEHOLDER_A", allowInPath: true },
      B: { value: "header-only", hosts: ["example.com"], placeholder: "PLACEHOLDER_B" },
    } });
    const result = await httpHooks.onRequest(new Request("https://example.com/PLACEHOLDER_A/PLACEHOLDER_B?token=PLACEHOLDER_A", { headers: { authorization: "Bearer PLACEHOLDER_B" } }));
    expect(result.url).toBe("https://example.com/allowed/PLACEHOLDER_B?token=PLACEHOLDER_A");
    expect(result.headers.get("authorization")).toBe("Bearer header-only");
  });

  test("leaves a URL path placeholder unchanged for a nonmatching host", async () => {
    const hooks = createHttpHooks({ secrets: { API_TOKEN: { allowInPath: true, value: "123:secret", hosts: ["api.example.com"], placeholder: "KINTSUGI_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://example.com/botKINTSUGI_SECRET_fake/getMe"));
    expectRequest(result);
    expect(result.url).toBe("https://example.com/botKINTSUGI_SECRET_fake/getMe");
  });

  test("URL-encodes reserved characters injected into a path", async () => {
    const hooks = createHttpHooks({ secrets: { API_TOKEN: { allowInPath: true, value: "secret value?#", hosts: ["api.example.com"], placeholder: "KINTSUGI_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://api.example.com/token/KINTSUGI_SECRET_fake"));
    expectRequest(result);
    expect(result.url).toBe("https://api.example.com/token/secret%20value%3F%23");
  });

  test("does not replace query string by default", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "KINTSUGI_SECRET_fake" } } });
    const result = await hooks.httpHooks.onRequest!(new Request("https://github.com/?token=KINTSUGI_SECRET_fake"));
    expectRequest(result);
    expect(result.url).toContain("KINTSUGI_SECRET_fake");
  });

  test("optionally replaces query string only for a matching host", async () => {
    const hooks = createHttpHooks({ replaceSecretsInQuery: true, secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "KINTSUGI_SECRET_fake" } } });
    const matching = await hooks.httpHooks.onRequest!(new Request("https://github.com/?token=KINTSUGI_SECRET_fake"));
    const nonmatching = await hooks.httpHooks.onRequest!(new Request("https://example.com/?token=KINTSUGI_SECRET_fake"));
    expectRequest(matching);
    expectRequest(nonmatching);
    expect(matching.url).toContain("token=real-secret");
    expect(nonmatching.url).toContain("token=KINTSUGI_SECRET_fake");
  });

  test("rejects duplicate and overlapping placeholders", () => {
    expect(() => createHttpHooks({ secrets: { A: { value: "a", hosts: ["*"], placeholder: "same" }, B: { value: "b", hosts: ["*"], placeholder: "same" } } })).toThrow(/duplicate/);
    expect(() => createHttpHooks({ secrets: { A: { value: "a", hosts: ["*"], placeholder: "KINTSUGI_SECRET_abc" }, B: { value: "b", hosts: ["*"], placeholder: "KINTSUGI_SECRET_abc123" } } })).toThrow(/overlaps/);
  });

  test("allows placeholder equal to secret for nested hooks", () => {
    const hooks = createHttpHooks({ secrets: { A: { value: "same", hosts: ["*"], placeholder: "same" } } });
    expect(hooks.env.A).toBe("same");
  });

  test("blocks real secret value sent to disallowed host", async () => {
    const hooks = createHttpHooks({ secrets: { GH_TOKEN: { value: "real-secret", hosts: ["github.com"], placeholder: "KINTSUGI_SECRET_fake" } } });
    await expect(hooks.httpHooks.onRequest!(new Request("https://example.com", { headers: { authorization: "Bearer real-secret" } }))).rejects.toBeInstanceOf(HttpRequestBlockedError);
  });
});

describe("host patterns and internal IP checks", () => {
  test("matches exact and wildcard github hosts without lookalikes", () => {
    expect(matchHostname("api.github.com", "api.github.com")).toBe(true);
    expect(matchHostname("github.com", "github.com")).toBe(true);
    expect(matchHostname("raw.githubusercontent.com", "*.githubusercontent.com")).toBe(true);
    expect(matchHostname("evilgithub.com", "*.github.com")).toBe(false);
    expect(matchHostname("github.com.evil.test", "github.com")).toBe(false);
  });

  test("detects internal and metadata IPs", () => {
    expect(isInternalAddress("169.254.169.254")).toBe(true);
    expect(isInternalAddress("100.100.100.200")).toBe(true);
    expect(isInternalAddress("10.1.2.3")).toBe(true);
    expect(isInternalAddress("127.0.0.1")).toBe(true);
    expect(isInternalAddress("8.8.8.8")).toBe(false);
    expect(isInternalAddress("::1")).toBe(true);
    expect(isInternalAddress("fc00::1")).toBe(true);
  });
});

describe("refreshable subscription secrets", () => {
  test("resolves on each authenticated request, not unrelated requests", async () => {
    let refreshes = 0;
    const hooks = createHttpHooks({ secrets: { subscription: {
      value: "", placeholder: "subscription-placeholder", hosts: ["api.anthropic.com"],
      resolve: async () => `token-${++refreshes}`,
    } } });
    await hooks.httpHooks.onRequest(new Request("https://api.anthropic.com/health"));
    expect(refreshes).toBe(0);
    for (const count of [1, 2]) {
      const response = await hooks.httpHooks.onRequest(new Request("https://api.anthropic.com/v1/messages", { headers: { authorization: "Bearer subscription-placeholder" } }));
      expect(response.headers.get("authorization")).toBe(`Bearer token-${count}`);
    }
    await expect(hooks.httpHooks.onRequest(new Request("https://example.com", { headers: { authorization: "Bearer subscription-placeholder" } }))).rejects.toBeInstanceOf(HttpRequestBlockedError);
    expect(refreshes).toBe(2);
  });

  test("disconnection and refresh failures propagate instead of sending stale credentials", async () => {
    const hooks = createHttpHooks({ secrets: { subscription: {
      value: "", placeholder: "subscription-placeholder", hosts: ["chatgpt.com"],
      resolve: async () => { throw new Error("Subscription disconnected"); },
    } } });
    await expect(hooks.httpHooks.onRequest(new Request("https://chatgpt.com/backend-api/codex/responses", { headers: { authorization: "Bearer subscription-placeholder" } }))).rejects.toThrow("Subscription disconnected");
  });
});

describe("response header scrubbing", () => {
  test("scrubs all known secrets, repeated and overlapping matches, without cascading replacements", () => {
    const { httpHooks } = createHttpHooks({ secrets: {
      A: { value: "abcde", hosts: ["github.com"] },
      B: { value: "defgh", hosts: ["other.example"] },
      C: { value: "REDACTED", hosts: ["other.example"] },
      empty: { value: "", hosts: ["github.com"] },
    } });
    const request = new Request("https://github.com");
    expect(httpHooks.scrubResponseHeader("abcdefgh abcde defgh", request)).toBe("[REDACTED] [REDACTED] [REDACTED]");
    expect(httpHooks.scrubResponseHeader("unrelated", request)).toBe("unrelated");
  });

  test("scrubs URL representations of secrets", () => {
    const { httpHooks } = createHttpHooks({ secrets: { A: { value: "secret value?#", hosts: ["github.com"] } } });
    for (const value of ["secret value?#", "secret%20value%3F%23", "secret+value%3F%23"]) {
      expect(httpHooks.scrubResponseHeader(`https://github.com/${value}`, new Request("https://github.com"))).toBe("https://github.com/[REDACTED]");
    }
  });

  test("keeps refreshed credentials request-scoped across concurrent responses", async () => {
    let version = 0;
    const { httpHooks } = createHttpHooks({ secrets: { A: { allowInPath: true,
      value: "", hosts: ["github.com"], placeholder: "PLACEHOLDER", resolve: async () => `credential-${++version}`,
    } } });
    const first = await httpHooks.onRequest(new Request("http://github.com/PLACEHOLDER"));
    const second = await httpHooks.onRequest(new Request("http://github.com/PLACEHOLDER"));
    expect(httpHooks.scrubResponseHeader(second.url, second)).toBe("http://github.com/[REDACTED]");
    expect(httpHooks.scrubResponseHeader(first.url, first)).toBe("http://github.com/[REDACTED]");
    expect(version).toBe(2);
  });
});

test("Basic-auth scrubbing tracks the combined username/password across refreshes and URL cloning", async () => {
  let version = 0;
  const { httpHooks: hooks } = createHttpHooks({ secrets: { TOKEN: {
    value: "", hosts: ["example.com"], placeholder: "PLACEHOLDER", allowInPath: true,
    resolve: async () => `credential-${++version}`,
  } } });
  const request = () => new Request("https://example.com/PLACEHOLDER", {
    headers: { authorization: `Basic ${Buffer.from("user:PLACEHOLDER").toString("base64")}` },
  });
  const first = await hooks.onRequest(request());
  const second = await hooks.onRequest(request());
  for (const outbound of [second, first]) {
    const authorization = outbound.headers.get("authorization")!;
    const encoded = authorization.slice("Basic ".length);
    expect(hooks.scrubResponseHeader(authorization, outbound)).toBe("Basic [REDACTED]");
    expect(hooks.scrubResponseHeader(`https://example.com/${encoded}`, outbound)).toBe("https://example.com/[REDACTED]");
    expect(hooks.scrubResponseHeader(`https://example.com/?auth=${encodeURIComponent(encoded)}`, outbound)).toBe("https://example.com/?auth=[REDACTED]");
    expect(hooks.scrubResponseHeader(outbound.url, outbound)).toBe("https://example.com/[REDACTED]");
  }
});

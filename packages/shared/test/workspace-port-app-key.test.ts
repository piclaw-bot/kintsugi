import { describe, expect, test } from "bun:test";
import { isWorkspaceLoopbackHost, parseWorkspacePortAppKey, workspacePortAppKey } from "../src/index.ts";

describe("workspace port app keys", () => {
  test.each(["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "kintsugi.localhost", "a.b.LOCALHOST"])("treats %s as a workspace host", (host) => {
    expect(isWorkspaceLoopbackHost(host)).toBe(true);
  });

  test.each(["example.com", "localhost.evil", "evil-localhost", ".localhost", "a..localhost", "-a.localhost"])("rejects %s", (host) => {
    expect(isWorkspaceLoopbackHost(host)).toBe(false);
  });

  test("gives each *.localhost name its own app per port", () => {
    expect(workspacePortAppKey(3000)).toBe("port-3000");
    expect(workspacePortAppKey(3000, "127.0.0.1")).toBe("port-3000");
    expect(workspacePortAppKey(3000, "Agents.localhost")).toBe("port-3000@agents.localhost");
    expect(() => workspacePortAppKey(3000, "example.com")).toThrow();
  });

  test("parses only well-formed port app keys", () => {
    expect(parseWorkspacePortAppKey("port-3000")).toEqual({ port: 3000, host: undefined });
    expect(parseWorkspacePortAppKey("port-3000@agents.localhost")).toEqual({ port: 3000, host: "agents.localhost" });
    expect(parseWorkspacePortAppKey("port-3000@example.com")).toBeUndefined();
    expect(parseWorkspacePortAppKey("file")).toBeUndefined();
  });
});

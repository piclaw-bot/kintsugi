import { expect, test } from "bun:test";
import { readSystemVersion, checkSupervisorRelease } from "../../src/server/supervisor.ts";

test("supervisor version is read without modifying settings; old status reports zero", async () => {
  for (const [body, version] of [[{}, 0], [{ systemVersion: 1 }, 1]] as const) {
    expect(await readSystemVersion(async (url) => {
      expect(String(url)).toBe("http://127.0.0.1:3001/status");
      return Response.json(body);
    })).toBe(version);
  }
  for (const body of [{ systemVersion: -1 }, { systemVersion: "1" }, { systemVersion: 2147483648 }]) await expect(readSystemVersion(async () => Response.json(body))).rejects.toThrow();
  await expect(readSystemVersion(async () => new Response("private", { status: 500 }))).rejects.toThrow("Cannot read installation compatibility status");
});

test("an older metadata API's missing requirement stays unknown, distinct from verified zero", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const old = await checkSupervisorRelease(async () => Response.json({ digest }));
  expect(old.requiredSystemVersion).toBeUndefined();
  for (const requiredSystemVersion of [0, 2]) expect((await checkSupervisorRelease(async () => Response.json({ digest, requiredSystemVersion }))).requiredSystemVersion).toBe(requiredSystemVersion);
  await expect(checkSupervisorRelease(async () => Response.json({ digest, requiredSystemVersion: -1 }))).rejects.toThrow("Invalid System release response");
});

test("malformed compatibility status cannot reflect private supervisor logs", async () => {
  const error = await readSystemVersion(async () => Response.json({ systemVersion: "private-fixture-token", logs: ["private-fixture-token"] })).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Expected a safe status error");
  expect(error.message).not.toContain("private-fixture-token");
});

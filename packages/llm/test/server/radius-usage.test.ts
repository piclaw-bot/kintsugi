import { expect, test } from "bun:test";
import { fetchRadiusUsage } from "../../src/server/radius-usage.ts";

test("Radius reports its credit balance and this month's spend without windows", async () => {
  const usage = await fetchRadiusUsage("token", async (url, init) => {
    expect(url).toBe("https://radius.pi.dev/v1/billing");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer token");
    return Response.json({
      ok: true, currency: "USD", as_of: "2026-10-02T18:00:00.000Z",
      balance: { credit_balance: 12.5, reserved: 0, available: 12.4, updated_at: null },
      current_period: { starts_at: "2026-10-01T00:00:00.000Z", ends_at: "2026-11-01T00:00:00.000Z", actual_charged: 3.28, actual_charge_count: 101 },
      all_time: { credited: 20, credit_count: 1, actual_charged: 7.6, actual_charge_count: 300 },
    });
  });
  expect(usage.windows).toEqual([]);
  expect(usage.balance).toEqual({ currency: "USD", available: 12.4, monthSpend: 3.28 });
});

test("rejected Radius credentials ask for a reconnect", async () => {
  await expect(fetchRadiusUsage("token", async () => new Response("", { status: 401 }))).rejects.toThrow("Reconnect Radius");
});

test("invalid currency codes are rejected before money formatting", async () => {
  await expect(fetchRadiusUsage("token", async () => Response.json({ currency: "NOT_A_CURRENCY", balance: { available: 1 }, current_period: { ends_at: "2026-11-01", actual_charged: 0 } }))).rejects.toThrow("unrecognized billing response");
});

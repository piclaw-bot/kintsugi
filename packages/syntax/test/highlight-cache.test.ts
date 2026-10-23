import { expect, test } from "bun:test";
import { HighlightCache } from "../src/highlight-cache.ts";

test("cache evicts least recently used entries at the entry limit", () => {
  const cache = new HighlightCache(100, 2);
  const result = { html: "1234" };
  cache.set("a", result);
  cache.set("b", result);
  expect(cache.get("a")).toBe(result);
  cache.set("c", result);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe(result);
  expect(cache.get("c")).toBe(result);
});

test("cache accounts for replacements and oversized entries within its character limit", () => {
  const cache = new HighlightCache(12, 10);
  cache.set("a", { html: "1234" });
  cache.set("c", { html: "1234" });
  cache.set("c", { html: "12345678" });
  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("c")?.html).toBe("12345678");
  cache.set("oversized", { html: "1234" });
  expect(cache.get("oversized")).toBeUndefined();
  expect(cache.get("c")).toBeDefined();
  cache.set("c", { html: "123456789012" });
  expect(cache.get("c")).toBeUndefined();
});

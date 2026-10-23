import { test } from "bun:test";
import { runGoTests } from "@kintsugi/core";
import { fileURLToPath } from "node:url";

test("the helper's Go tests pass", () => runGoTests(fileURLToPath(new URL("../helper", import.meta.url))), 120_000);

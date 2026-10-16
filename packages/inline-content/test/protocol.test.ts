import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { inlineContentFrameMessage } from "../src/shared/inline-content-protocol.ts";

test("visual input protocol permits scrolling but never host keyboard command messages", () => {
  expect(Value.Check(inlineContentFrameMessage, { type: "scroll", deltaY: -120 })).toBe(true);
  expect(Value.Check(inlineContentFrameMessage, { type: "keydown", key: "Escape", code: "Escape", altKey: true, ctrlKey: false, metaKey: true, shiftKey: false, repeat: false })).toBe(false);
  expect(Value.Check(inlineContentFrameMessage, { type: "scroll", deltaY: Infinity })).toBe(false);
});

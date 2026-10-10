import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { desktopClipboardSetMessage, desktopViewerMessage } from "../src/messages.ts";

test("viewer messages validate status and both clipboard notifications", () => {
  expect(Value.Check(desktopViewerMessage, { type: "kintsugi:desktop:status", token: "frame-token", phase: "connected", detail: "" })).toBe(true);
  for (const type of ["kintsugi:desktop:clipboard", "kintsugi:desktop:clipboard-sent"]) {
    expect(Value.Check(desktopViewerMessage, { type, token: "frame-token", text: "First line\nSecond line" })).toBe(true);
  }
  expect(Value.Check(desktopViewerMessage, { type: "kintsugi:desktop:status", token: "frame-token", phase: "unknown", detail: "" })).toBe(false);
  expect(Value.Check(desktopViewerMessage, { type: "kintsugi:desktop:clipboard", text: "Missing token" })).toBe(false);
});

test("clipboard commands and viewer notifications have distinct directions", () => {
  const command = { type: "kintsugi:desktop:clipboard-set", token: "frame-token", text: "" };
  expect(Value.Check(desktopClipboardSetMessage, command)).toBe(true);
  expect(Value.Check(desktopViewerMessage, command)).toBe(false);
  expect(Value.Check(desktopClipboardSetMessage, { ...command, text: 42 })).toBe(false);
  expect(Value.Check(desktopClipboardSetMessage, { ...command, type: "kintsugi:desktop:clipboard-sent" })).toBe(false);
});

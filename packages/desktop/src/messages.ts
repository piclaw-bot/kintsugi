import { Type, type Static } from "typebox";

const desktopPhase = Type.Union([
  Type.Literal("connecting"), Type.Literal("connected"), Type.Literal("disconnected"),
  Type.Literal("starting"), Type.Literal("stopped"), Type.Literal("failed"),
]);
export type DesktopPhase = Static<typeof desktopPhase>;

const statusMessage = Type.Object({
  type: Type.Literal("kintsugi:desktop:status"),
  token: Type.String(),
  phase: desktopPhase,
  detail: Type.String(),
});

const clipboardFields = { token: Type.String(), text: Type.String() };
const clipboardMessage = Type.Object({
  type: Type.Union([Type.Literal("kintsugi:desktop:clipboard"), Type.Literal("kintsugi:desktop:clipboard-sent")]),
  ...clipboardFields,
});

export const desktopViewerMessage = Type.Union([statusMessage, clipboardMessage]);
export const desktopClipboardSetMessage = Type.Object({ type: Type.Literal("kintsugi:desktop:clipboard-set"), ...clipboardFields });
export type DesktopViewerPayload = Omit<Static<typeof statusMessage>, "token"> | Omit<Static<typeof clipboardMessage>, "token">;

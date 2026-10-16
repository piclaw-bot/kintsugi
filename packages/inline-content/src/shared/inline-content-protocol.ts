import { Type } from "typebox";

export const inlineContentFrameMessage = Type.Union([
  Type.Object({ type: Type.Literal("ready") }),
  Type.Object({ type: Type.Literal("size"), height: Type.Number({ minimum: 0, maximum: 1000000 }), overflow: Type.Boolean() }),
  Type.Object({ type: Type.Literal("error"), message: Type.String({ maxLength: 10000 }) }),
  Type.Object({ type: Type.Literal("scroll"), deltaY: Type.Number() }),
  Type.Object({ type: Type.Literal("link"), href: Type.String({ pattern: "^https?://", maxLength: 8192 }) }),
]);
export const inlineContentThemeMessage = Type.Object({ type: Type.Literal("theme"), theme: Type.String({ maxLength: 64 }), fontSize: Type.String({ pattern: "^\\d+(\\.\\d+)?px$" }) });
export const inlineContentConnectMessage = Type.Object({ type: Type.Literal("inline-content-connect") });

import { readdirSync } from "node:fs";
import type { StaticFileContribution } from "@kintsugi/shared";

const distribution = new URL("./", import.meta.resolve("katex"));
const fonts = new URL("fonts/", distribution);

/** Local, fingerprintable KaTeX CSS and fonts; never fetch math assets from a CDN. */
export const markdownMathStaticFiles = {
  "/katex.css": { url: new URL("katex.min.css", distribution), contentType: "text/css; charset=utf-8" },
  "/markdown-math.css": { url: new URL("./math.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  ...Object.fromEntries(readdirSync(fonts).map((name) => {
    const extension = name.slice(name.lastIndexOf(".") + 1);
    return [`/fonts/${name}`, { url: new URL(name, fonts), contentType: `font/${extension}` }];
  })),
} satisfies Record<string, StaticFileContribution>;

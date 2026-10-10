import { expect, test } from "bun:test";
import { diagramPath, vendorPath } from "../src/server/paths.ts";

test("diagram paths normalize relative names and reject unsupported formats", () => {
  expect(diagramPath(" diagrams/example.drawio ")).toBe("/work/diagrams/example.drawio");
  expect(diagramPath("/work/example.drawio.xml")).toBe("/work/example.drawio.xml");
  expect(() => diagramPath("/etc/example.xml")).toThrow();
  expect(() => diagramPath("../example.drawio")).toThrow();
  expect(() => diagramPath("example.drawio.png")).toThrow();
  expect(() => diagramPath("")).toThrow();
  expect(() => diagramPath("bad\0.drawio")).toThrow();
});
test("vendor asset paths cannot escape their bundle", () => {
  expect(vendorPath("js/app.min.js")).toBe("js/app.min.js");
  for (const path of ["../package.json", "%2e%2e/package.json", "js/../../x", "js\\app.js", "%00", "/index.html", "js/%2e%2e/index.html"]) expect(() => vendorPath(path)).toThrow();
});

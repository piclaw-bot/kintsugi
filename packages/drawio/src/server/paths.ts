import { posix } from "node:path";
import { invalidArguments } from "@kintsugi/core";

export const emptyDiagram = '<mxfile><diagram name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

export function diagramPath(input: string): string {
  if (!input.trim() || input.includes("\0")) throw invalidArguments("Choose a .drawio or .xml file");
  const path = posix.resolve("/work", input.trim());
  if (!path.startsWith("/work/")) throw invalidArguments("Choose a file inside /work");
  if (!/\.(drawio|xml)$/i.test(path)) throw invalidArguments("Choose a .drawio or .xml file; embedded PNG and SVG diagrams are not supported yet");
  return path;
}

export function vendorPath(input: string): string {
  const path = decodeURIComponent(input);
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some(part => part === ".." || part === ".")) throw invalidArguments("Invalid editor asset path");
  return path;
}

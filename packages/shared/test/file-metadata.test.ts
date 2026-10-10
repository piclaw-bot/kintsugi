import { expect, test } from "bun:test";
import { extensionOf, imageMimeByExtension } from "@kintsugi/shared/file-metadata";

test("file extensions are case-insensitive and use the final suffix", () => {
  expect(extensionOf("/work/photo.JPEG")).toBe("jpeg");
  expect(extensionOf("archive.tar.gz")).toBe("gz");
  expect(extensionOf(".png")).toBe("png");
  expect(extensionOf("photo.")).toBe("");
});

test("image metadata uses the same MIME type for both JPEG extensions", () => {
  expect(imageMimeByExtension[extensionOf("photo.JPG")]).toBe("image/jpeg");
  expect(imageMimeByExtension[extensionOf("photo.jpeg")]).toBe("image/jpeg");
  expect(imageMimeByExtension[extensionOf("drawing.SVG")]).toBe("image/svg+xml");
  expect(imageMimeByExtension[extensionOf("notes.txt")]).toBeUndefined();
});

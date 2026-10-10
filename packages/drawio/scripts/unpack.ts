import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";

const target = new URL("../../../apps/web/public/drawio/", import.meta.url);
await mkdir(target, { recursive: true });
const bytes = await Bun.file(new URL("../vendor/drawio-31.4.2.tar.gz", import.meta.url)).arrayBuffer();
const expectedSha256 = "e0c7414715bcddafc071b5aadba984237313a59310523cdfcaef0da1bd8b41c7";
if (createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !== expectedSha256) throw new Error("Draw.io vendor archive checksum mismatch");
const archive = new Bun.Archive(bytes);
await archive.extract(target.pathname);

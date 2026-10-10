import { expect, test } from "bun:test";
import { ensureGeneratedDefaultWorkspaceImage, prepareDefaultWorkspaceImage } from "./default-image.ts";

test("default image embeds its deterministic tag signature as a label", async () => {
  const first = await prepareDefaultWorkspaceImage();
  try {
    const second = await prepareDefaultWorkspaceImage();
    try {
      const signature = first.metadata.tag.slice("kintsugi-workspace:".length);
      expect(signature).toMatch(/^[a-f0-9]{16}$/);
      const dockerfile = await Bun.file(first.dockerfile).text();
      expect(dockerfile).toContain(`LABEL com.kintsugi.workspace-image.signature="${signature}"\n`);
      expect(second.metadata.tag).toBe(first.metadata.tag);
      expect(await Bun.file(second.dockerfile).text()).toBe(dockerfile);
    } finally { await second.dispose(); }
  } finally { await first.dispose(); }
});

test("one context supports local reuse, missing-image rebuild and publication identity", async () => {
  const context = await prepareDefaultWorkspaceImage();
  let builds = 0;
  const images = new Set<string>();
  const options = {
    context,
    exists: async (image: string) => images.has(image),
    build: async (_context: typeof context, image: string) => { builds++; images.add(image); },
  };
  try {
    const first = await ensureGeneratedDefaultWorkspaceImage(options);
    expect(first).toBe(context.metadata.tag);
    expect(await ensureGeneratedDefaultWorkspaceImage(options)).toBe(first);
    expect(builds).toBe(1);
    images.delete(first);
    await ensureGeneratedDefaultWorkspaceImage(options);
    expect(builds).toBe(2);
    const published = await ensureGeneratedDefaultWorkspaceImage({ ...options, imageName: tag => tag.replace("kintsugi-workspace:", "ghcr.io/example/workspace:") });
    expect(published.split(":").at(-1)).toBe(first.split(":").at(-1));
    expect(builds).toBe(3);
  } finally { await context.dispose(); }
});

// Claude Code is already a background workspace tab in Kintsugi. Keep its work in the
// foreground so a completed turn leaves a result the user can actually inspect.
test("new shared homes default Claude background tasks off through editable user settings", async () => {
  const context = await prepareDefaultWorkspaceImage();
  try {
    const dockerfile = await Bun.file(context.dockerfile).text();
    expect(dockerfile).toContain('COPY "files/base/rootfs/opt/kintsugi/home-defaults/.claude/settings.json" "/opt/kintsugi/home-defaults/.claude/settings.json"');
    expect(dockerfile).toContain('RUN chmod "0600" "/opt/kintsugi/home-defaults/.claude/settings.json"');
    expect(JSON.parse(await Bun.file(context.dockerfile.replace(/Dockerfile$/, "files/base/rootfs/opt/kintsugi/home-defaults/.claude/settings.json")).text())).toEqual({
      env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
    });
  } finally { await context.dispose(); }
});

test("every default image build checks home against the original base skeleton", async () => {
  const context = await prepareDefaultWorkspaceImage();
  try {
    const dockerfile = await Bun.file(context.dockerfile).text();
    const snapshot = dockerfile.indexOf("cp -a /etc/skel/. /opt/kintsugi/home-defaults/");
    const check = dockerfile.indexOf("RUN diff -r --no-dereference /opt/kintsugi/home-defaults /home/agent");
    expect(snapshot).toBeGreaterThan(0);
    expect(snapshot).toBeLessThan(dockerfile.indexOf("# Module: base"));
    expect(check).toBeGreaterThan(dockerfile.lastIndexOf("# Module:"));
    expect(check).toBeLessThan(dockerfile.indexOf("# Files independent of module setup"));
  } finally { await context.dispose(); }
});

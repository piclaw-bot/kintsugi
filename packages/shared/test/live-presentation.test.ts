import { expect, test } from "bun:test";
import { createLivePresentation, liveRegionDigests, type LiveRegion } from "../src/live-presentation.ts";

const transcript = (rows: readonly string[]): LiveRegion => ({
  target: "transcript",
  html: rows.map((_, index) => `<div id="row-${index}" data-turbo-permanent></div>`).join(""),
  children: rows.map((html, index) => ({ target: `row-${index}`, html })),
});


test("a page's first snapshot omits what it shows, and later changes still arrive", () => {
  let regions = [transcript(["<p>First</p>"]), { target: "actions", html: "<button>Send</button>" }];
  const presentation = createLivePresentation(() => regions);
  const published: string[] = [];
  presentation.subscribe(html => published.push(html), liveRegionDigests(regions));
  expect(published).toEqual([""]);

  regions = [transcript(["<p>First</p>", "<p>Second</p>"]), regions[1]!];
  presentation.flush();
  expect(published[1]).toContain('target="transcript"');
  expect(published[1]).toContain("Second");
  expect(published[1]).not.toContain("Send");
});

test("regions a page didn't place, or that changed since, are sent", () => {
  const placed = transcript(["<p>First</p>"]);
  const shown = liveRegionDigests([placed]);
  const published: string[] = [];
  createLivePresentation(() => [transcript(["<p>Edited</p>"]), { target: "actions", html: "<button>Send</button>" }]).subscribe(html => published.push(html), shown);
  expect(published[0]).not.toContain('target="transcript"');
  expect(published[0]).toContain("Edited");
  expect(published[0]).toContain("Send");
});


import { Type, type Static } from "typebox";
import { escapeHtml, turboStream } from "./index.ts";

/** A region owns its markup; nested independently-owned islands use data-turbo-permanent. */
export interface LiveRegion {
  target: string;
  html: string;
  action?: "update" | "replace";
  /** Replace this region's children rather than morphing client-enhanced markup. */
  morph?: boolean;
  /** Append-only HTML prefix. Resetting the prefix sends an authoritative replacement. */
  appendOnly?: boolean;
  children?: readonly LiveRegion[];
}

export interface LiveSubscription {
  unsubscribe(): void;
}

/** Digests of the regions a server-rendered page shows, by target. */
export const liveRegionDigestsSchema = Type.Record(Type.String(), Type.String());
export type LiveRegionDigests = Readonly<Static<typeof liveRegionDigestsSchema>>;

/** Carries a page's shown regions on the element whose controller subscribes; the Cable client sends them until a snapshot is applied. */
export const liveShownAttribute = "data-live-shown";

function liveRegionDigest(html: string): string {
  return Bun.hash(html).toString(36);
}

/** Markup for a region's target exactly as applying its snapshot leaves it: the target's
 * content, or for `replace` the element itself, with every child region placed. */
function liveRegionHtml(region: LiveRegion): string {
  return region.children?.length ? fill(region.html, region.children) : region.html;
}

/** Places regions into the elements of `html` they target. */
function fill(html: string, regions: readonly LiveRegion[], subscriber?: { id: string; shown: LiveRegionDigests }): string {
  const byTarget = new Map(regions.map(region => [region.target, region]));
  return new HTMLRewriter().on("[id]", { element(element) {
    const id = element.getAttribute("id")!;
    if (id === subscriber?.id) element.setAttribute(liveShownAttribute, JSON.stringify(subscriber.shown));
    const region = byTarget.get(id);
    if (!region) return;
    const content = liveRegionHtml(region);
    if (region.action === "replace") element.replace(content, { html: true });
    else element.setInnerContent(content, { html: true });
  } }).transform(html);
}

/** A shell whose live content another presentation owns, as a page shows it: the regions
 * it has mounts for placed, and its subscriber marked with exactly those. */
export function placeLiveRegions(shell: string, regions: readonly LiveRegion[], subscriberId: string): string {
  const mounts = new Set<string>();
  new HTMLRewriter().on("[id]", { element(element) { mounts.add(element.getAttribute("id")!); } }).transform(shell);
  const placed = regions.filter(region => mounts.has(region.target));
  return fill(shell, placed, { id: subscriberId, shown: liveRegionDigests(placed) });
}

/** What a page that placed these regions shows. A subscription's first snapshot omits those still current. */
export function liveRegionDigests(regions: readonly LiveRegion[], digests: Record<string, string> = {}): LiveRegionDigests {
  for (const region of regions) {
    digests[region.target] = liveRegionDigest(region.html);
    if (region.children) liveRegionDigests(region.children, digests);
  }
  return digests;
}

function regionStreams(regions: readonly LiveRegion[], previous: Map<string, string>, snapshot: boolean, shown: LiveRegionDigests = {}): string {
  let html = "";
  for (const region of regions) {
    const before = previous.get(region.target);
    const changed = snapshot || before !== region.html;
    if (snapshot && shown[region.target] === liveRegionDigest(region.html)) previous.set(region.target, region.html);
    else if (changed) {
      const append = !snapshot && region.appendOnly && before !== undefined && region.html.startsWith(before);
      html += turboStream(append ? "append" : region.action ?? "update", region.target, append ? region.html.slice(before.length) : region.html, append || region.morph === false ? {} : { method: "morph" });
      previous.set(region.target, region.html);
    }
    if (region.children) html += regionStreams(region.children, previous, changed, shown);
  }
  return html;
}

/** One synchronous read/render/send path for initial state, changes and reconnects.
 * Invalidation coalesces; no snapshots, promises or event history are queued. */
export function createLivePresentation(render: () => readonly LiveRegion[], intervalMs = 0) {
  const listeners = new Set<(html: string) => void>();
  const previous = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function flush(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (disposed || listeners.size === 0) return;
    const regions = render();
    const html = regionStreams(regions, previous, false);
    const targets = new Set<string>();
    const visit = (items: readonly LiveRegion[]): void => {
      for (const item of items) { targets.add(item.target); if (item.children) visit(item.children); }
    };
    visit(regions);
    for (const target of previous.keys()) if (!targets.has(target)) previous.delete(target);
    if (html) for (const listener of listeners) listener(html);
  }

  return {
    invalidate(): void {
      if (!disposed && listeners.size && timer === undefined) timer = setTimeout(flush, intervalMs);
    },
    flush,
    /** `shown` comes from the subscriber's server-rendered page; its snapshot omits regions still current. */
    subscribe(listener: (html: string) => void, shown?: LiveRegionDigests): LiveSubscription {
      if (disposed) throw new Error("Live presentation is disposed");
      // Bring existing clients to the same published state before the new mount joins.
      flush();
      const regions = render();
      const html = regionStreams(regions, previous, true, shown);
      listeners.add(listener);
      try { listener(html); } catch (error) { listeners.delete(listener); throw error; }
      return { unsubscribe() {
        listeners.delete(listener);
        if (listeners.size === 0) {
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          previous.clear();
        }
      } };
    },
    dispose(): void {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      listeners.clear();
      previous.clear();
    },
  };
}

/** A keyed collection is represented by stable islands and independently rendered rows.
 * One generic morph reorders/removes islands; row updates never remount unchanged rows. */
export function liveCollection(target: string, rows: readonly { id: string; html: string; children?: readonly LiveRegion[] }[]): LiveRegion {
  return {
    target,
    html: rows.map(({ id }) => `<div id="${escapeHtml(id)}" data-turbo-permanent></div>`).join(""),
    children: rows.map(({ id, html, children }) => ({ target: id, html, children })),
  };
}

/** Asynchronous enrichment ends here, before publication. Invalidations during a
 * load discard its result. All waiters join the latest refresh, never an old one. */
export function createPublishedRefresh<T>(load: () => Promise<T>, publish: (value: T) => void) {
  let generation = 0;
  let pending: Promise<void> | undefined;
  let disposed = false;
  return {
    invalidate(): void { generation++; },
    refresh(): Promise<void> {
      if (disposed) throw new Error("Published refresh is disposed");
      generation++;
      if (pending) return pending;
      const completion = Promise.withResolvers<void>();
      pending = completion.promise;
      void (async () => {
        try {
          for (;;) {
            const started = generation;
            const value = await load();
            if (disposed) return;
            if (started !== generation) continue;
            publish(value);
            if (started === generation) return;
          }
        } finally {
          // Release ownership in the worker's final synchronous step, not in a
          // later promise reaction that could swallow a new refresh request.
          pending = undefined;
        }
      })().then(completion.resolve, completion.reject);
      return completion.promise;
    },
    dispose(): void { disposed = true; generation++; },
  };
}

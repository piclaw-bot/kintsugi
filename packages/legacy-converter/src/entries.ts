import { defineEntry } from "@earendil-works/pi-durable";

/** Native output vocabulary. Importing this subpath never loads the legacy SDK. */
export const historyNote = defineEntry<{ text: string; tone: "system" | "summary" }>("kintsugi.history-note");

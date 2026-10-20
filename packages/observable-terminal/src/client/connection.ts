import { encodeObservableTerminalMessage, terminalSessionMissingCloseCode } from "../shared/index.ts";

export type TerminalConnectionState = "connecting" | "connected" | "reconnecting" | "unavailable" | "ended";
export interface TerminalSize { cols: number; rows: number }

/** The transport can attach while a fresh renderer initializes. It owns retries
 * and page suspension, but not a terminal renderer or its lifetime. */
export function createTerminalConnection(options: {
  url: URL;
  interactive: boolean;
  size: TerminalSize;
  output(data: string | Uint8Array): void;
  onOutput?: (text: string) => void;
  state(state: TerminalConnectionState): void;
  disconnectedMessage?: string;
  errorMessage?: string;
}) {
  let ws: WebSocket | undefined;
  let size = options.size;
  let sentSize = size;
  let disposed = false;
  let paused = false;
  let state: TerminalConnectionState = "connecting";
  const report = (next: TerminalConnectionState): void => { state = next; options.state(next); };
  let suspended = options.interactive && document.hidden;
  let hasConnected = false;
  let openedAt = 0;
  const retryDelays = [100, 250, 500, 1000, 2000, 5000, 5000, 5000];
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempts = 0;
  const cancelRetry = (): void => { clearTimeout(retryTimer); retryTimer = undefined; };
  const disconnect = (): void => {
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    ws.close();
    ws = undefined;
  };
  const send = (data: string): void => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(data);
  };
  const sendSize = (): void => {
    if (ws?.readyState !== WebSocket.OPEN || (size.cols === sentSize.cols && size.rows === sentSize.rows)) return;
    sentSize = size;
    send(encodeObservableTerminalMessage({ type: "resize", ...size }));
  };
  const connect = (force = false): void => {
    if (disposed || paused || state === "ended" || (options.interactive && (suspended || document.hidden))) return;
    if (!force && ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    cancelRetry();
    disconnect();
    if (options.interactive) {
      report(hasConnected || retryAttempts > 0 ? "reconnecting" : "connecting");
      sentSize = size;
      options.url.searchParams.set("cols", String(size.cols));
      options.url.searchParams.set("rows", String(size.rows));
    }
    openedAt = 0;
    const socket = ws = new WebSocket(options.url);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      openedAt = Date.now();
      hasConnected = true;
      if (options.interactive) sendSize();
      report("connected");
    };
    const outputDecoder = new TextDecoder();
    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;
      options.onOutput?.(data instanceof Uint8Array ? outputDecoder.decode(data, { stream: true }) : data);
      options.output(data);
    };
    socket.onclose = (event) => {
      if (ws !== socket || disposed) return;
      ws = undefined;
      if (event.code === terminalSessionMissingCloseCode) {
        cancelRetry();
        report("ended");
        return;
      }
      if (options.interactive) {
        if (suspended || document.hidden) return;
        // A failed attach can open and immediately close; do not count it as recovery.
        if (openedAt && Date.now() - openedAt >= 10_000) retryAttempts = 0;
        if (retryAttempts >= retryDelays.length) { report("unavailable"); return; }
        report("reconnecting");
        const delay = retryDelays[retryAttempts++]!;
        retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, delay);
      } else {
        if (options.disconnectedMessage) options.output(options.disconnectedMessage);
        report("unavailable");
      }
    };
    socket.onerror = () => {
      if (!options.interactive && options.errorMessage) options.output(options.errorMessage);
    };
  };
  const suspend = (): void => {
    if (disposed || state === "ended") return;
    suspended = true;
    cancelRetry();
    disconnect();
    report("reconnecting");
  };
  const resume = (): void => {
    if (disposed || document.hidden || !suspended) return;
    suspended = false;
    retryAttempts = 0;
    connect(true);
  };
  const visibilityChanged = (): void => { if (document.hidden) suspend(); else resume(); };
  const networkRestored = (): void => {
    if (disposed || document.hidden || suspended) return;
    retryAttempts = 0;
    connect(true);
  };
  let started = false;
  const reconnect = (): void => {
    if (disposed) return;
    paused = false;
    if (!started) {
      started = true;
      suspended = options.interactive && document.hidden;
      if (options.interactive) {
        document.addEventListener("visibilitychange", visibilityChanged);
        window.addEventListener("pagehide", suspend);
        window.addEventListener("pageshow", resume);
        window.addEventListener("online", networkRestored);
      }
    }
    retryAttempts = 0;
    connect(true);
  };
  return {
    get state(): TerminalConnectionState { return state; },
    send,
    /** Stop an early attachment until its renderer can consume a fresh tmux snapshot. */
    pause(): void { paused = true; cancelRetry(); disconnect(); },
    resize(next: TerminalSize): void { size = next; sendSize(); },
    reconnect,
    dispose(): void {
      disposed = true;
      cancelRetry();
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("online", networkRestored);
      disconnect();
    },
  };
}

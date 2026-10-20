import { observableTerminalEnvironment } from "./constants.ts";

// Reserved by the workspace bridge, never a foreground program's exit status.
const sessionMissingExitCode = 44;
const terminalBridgeSource = String.raw`
// Runs under Bun inside the workspace. Docker transports pipes, not a PTY:
// stdin is newline-delimited input/resize commands; stdout is raw PTY output.
// Owning the PTY here makes stdin EOF detach tmux even if Kintsugi disappears.
import { createInterface } from "node:readline";
const { args, cols, rows, sessionCheckArgs, missingExitCode } = JSON.parse(process.argv[1]);
function sessionExists() {
  const check = Bun.spawnSync(["tmux", ...sessionCheckArgs], { stdout: "ignore", stderr: "pipe" });
  if (check.exitCode === 0) return true;
  const diagnostic = new TextDecoder().decode(check.stderr);
  if (check.exitCode === 1 && /can't find session:|no server running|error connecting to .*\(No such file or directory\)/.test(diagnostic)) return false;
  throw new Error(diagnostic || "tmux session check failed with exit code " + check.exitCode);
}
// Checking here avoids a separate Docker execution before every attachment.
if (sessionCheckArgs && !sessionExists()) process.exit(missingExitCode);
const terminal = new Bun.Terminal({
  name: "xterm-256color",
  cols,
  rows,
  data: (_terminal, data) => process.stdout.write(data),
});
const child = Bun.spawn(["tmux", ...args], { terminal });
let closed = false;
function close() {
  if (closed) return;
  closed = true;
  // Hang up this client, never the tmux server or the program in its pane.
  child.kill("SIGHUP");
  terminal.close();
}
process.on("SIGTERM", close);
process.on("SIGHUP", close);
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (closed) return;
  const message = JSON.parse(line);
  if (message.type === "input") terminal.write(message.data);
  else if (message.type === "resize") {
    terminal.resize(message.cols, message.rows);
    child.kill("SIGWINCH");
  } else throw new Error("Unknown terminal bridge message: " + message.type);
});
input.on("close", close);
void child.exited.then(async (exitCode) => {
  // Process exit can precede the PTY read callback in the same poll cycle.
  // Let that callback forward the final bytes before closing the master.
  if (!closed) await new Promise(setImmediate);
  const missing = sessionCheckArgs && !closed && !sessionExists();
  if (!closed) terminal.close();
  closed = true;
  input.close();
  process.stdin.destroy();
  process.exitCode = missing ? missingExitCode : exitCode;
});
`;

export interface ObservableTerminalConnection {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface ObservableTerminalEvents {
  onData(data: Uint8Array): void;
  onExit(exitCode: number, reason?: "session-missing"): void;
}

export interface HostObservableTerminalAttachOptions {
  session: string;
  /** Optional isolated tmux server, for System-owned host sessions. */
  socketName?: string;
  /** Attach only; never start a replacement server for a missing execution. */
  requireExistingServer?: boolean;
  cols: number;
  rows: number;
  readonly?: boolean;
  fixedSize?: boolean;
  env?: Record<string, string>;
}

export interface ObservableTerminalAttachOptions extends HostObservableTerminalAttachOptions {
  containerName: string;
  user?: string;
  workdir?: string;
  /** Detect missing sessions inside the same workspace bridge used to attach. */
  reportSessionMissing?: boolean;
}

function tmuxAttachArgs(options: HostObservableTerminalAttachOptions): string[] {
  const args: string[] = options.requireExistingServer ? ["-N"] : [];
  if (options.socketName) args.push("-L", options.socketName);
  if (!options.readonly) {
    // History belongs to tmux, not the browser terminal. Configure each attachment
    // so new and existing sessions work without caller-specific preparation.
    args.push(
      "set-option", "-t", options.session, "mouse", "on", ";",
      "set-option", "-t", options.session, "set-clipboard", "on", ";",
      "bind-key", "-n", "S-PPage", "copy-mode -e ; send-keys -X page-up", ";",
      "bind-key", "-T", "copy-mode", "S-PPage", "send-keys -X page-up", ";",
      "bind-key", "-T", "copy-mode", "S-NPage", "send-keys -X page-down", ";",
    );
  }
  if (options.fixedSize) {
    args.push("set-option", "-t", `${options.session}:`, "window-size", "manual", ";", "resize-window", "-t", `${options.session}:`, "-x", String(options.cols), "-y", String(options.rows), ";");
  }
  // Tell tmux that the Gespenst client accepts OSC 8. Pi probes this client
  // feature before emitting file:// hyperlinks; RGB alone is not enough.
  if (!options.readonly) {
    // Older tmux expands only the first terminal-features array entry in a format.
    // A server-local marker keeps setup idempotent without shells or overwriting user entries.
    args.push("if-shell", "-F", "#{@kintsugi-terminal-client-features}", "", "set-option -gas terminal-features ,xterm-256color:hyperlinks ; set-option -gas terminal-features ,xterm-256color:clipboard ; set-option -g @kintsugi-terminal-client-features 1", ";");
  }
  args.push("attach-session");
  if (options.readonly) args.push("-r");
  args.push("-t", options.session);
  return args;
}

export function buildAttachArgs(options: ObservableTerminalAttachOptions): string[] {
  const env = { ...observableTerminalEnvironment, ...options.env };
  const args = ["exec", "-i", "--user", options.user ?? "agent"];
  if (options.workdir) args.push("--workdir", options.workdir);
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  args.push(options.containerName, "bun", "-e", terminalBridgeSource, JSON.stringify({
    args: tmuxAttachArgs(options), cols: options.cols, rows: options.rows,
    sessionCheckArgs: options.reportSessionMissing
      ? ["-N", ...(options.socketName ? ["-L", options.socketName] : []), "has-session", "-t", `=${options.session}`]
      : undefined,
    missingExitCode: sessionMissingExitCode,
  }));
  return args;
}

export function attachHostObservableTerminal(options: HostObservableTerminalAttachOptions, events: ObservableTerminalEvents): ObservableTerminalConnection {
  const env = { ...process.env, ...observableTerminalEnvironment, ...options.env, TMUX: undefined, TMUX_PANE: undefined };
  const terminal = new Bun.Terminal({
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    data: (_terminal, data) => events.onData(data),
  });
  const subprocess = Bun.spawn({ cmd: ["tmux", ...tmuxAttachArgs(options)], env, terminal });

  let closed = false;
  void subprocess.exited.then(async (exitCode) => {
    // Drain the current poll cycle before reporting exit to the viewer.
    if (!closed) await new Promise<void>((resolve) => setImmediate(resolve));
    if (!closed) terminal.close();
    closed = true;
    events.onExit(exitCode);
  });

  return {
    write: (data) => { if (!closed) terminal.write(data); },
    resize: (cols, rows) => {
      if (closed) return;
      terminal.resize(cols, rows);
      // Bun's PTY resize updates dimensions without notifying the client.
      subprocess.kill("SIGWINCH");
    },
    close: () => {
      if (closed) return;
      closed = true;
      subprocess.kill("SIGHUP");
      terminal.close();
    },
  };
}

export function attachObservableTerminal(options: ObservableTerminalAttachOptions, events: ObservableTerminalEvents): ObservableTerminalConnection {
  // Killing `docker exec -t` leaves its remote PTY and tmux client alive.
  // Instead, the workspace bridge owns that PTY and hangs it up on stdin EOF.
  const subprocess = Bun.spawn(["docker", ...buildAttachArgs(options)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let closed = false;
  const output = (async () => {
    for await (const chunk of subprocess.stdout) events.onData(chunk);
  })();
  const errors = new Response(subprocess.stderr).text();
  void (async () => {
    const [exitCode, stderr] = await Promise.all([subprocess.exited, errors, output]);
    if (exitCode !== 0 && !closed && stderr) {
      events.onData(new TextEncoder().encode(`\r\n${stderr.replace(/\r?\n/g, "\r\n")}`));
    }
    closed = true;
    events.onExit(exitCode, options.reportSessionMissing && exitCode === sessionMissingExitCode ? "session-missing" : undefined);
  })();
  const send = (message: { type: "input"; data: string } | { type: "resize"; cols: number; rows: number }): void => {
    if (!closed) subprocess.stdin.write(`${JSON.stringify(message)}\n`);
  };
  return {
    write: (data) => send({ type: "input", data }),
    resize: (cols, rows) => send({ type: "resize", cols, rows }),
    close: () => {
      if (closed) return;
      closed = true;
      subprocess.stdin.end();
    },
  };
}

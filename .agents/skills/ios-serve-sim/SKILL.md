---
name: ios-serve-sim
description: Use a workspace-owned remote iOS simulator to review web/PWA work, interact with apps, and show the live device in Kintsugi's preview. Use for simulator taps, typing, gestures, rotation, camera, accessibility, and WebKit inspection.
---

# Remote iOS simulator

Use `ios-serve-sim` for ownership, SSH tunnels, and cleanup; use upstream `serve-sim` for simulator operations. Run these commands from the repository root. This is for manual review and exploration, not writing UI tests.

## Start and present

1. Check `bun tools/ios-serve-sim/cli.ts --help`. The existing `REMOTEMAC` setting must identify the simulator Mac; don't run Mac prerequisite checks on the Linux workspace.
2. Reuse an existing viewer if running. Otherwise start one in tmux:

   ```sh
   tmux new-session -d -s ios-serve-sim -c /work \
     'bun tools/ios-serve-sim/cli.ts serve --model "iPhone 17" -- --fit --panes tools'
   ```

   Startup installs pinned tools and creates an owned device. Watch `tmux capture-pane -pt ios-serve-sim`; wait for upstream's ready URL. Use `--codec mjpeg` only when needed; the default allows upstream's more bandwidth-efficient codec selection.
3. Present `http://localhost:4101/` with Kintsugi's browser presentation tool. This is the workspace's tunnel, not localhost on the user's computer. Confirm the device is live and the requested page is visible before saying it's ready.

## Connect a workspace web server

Run the dev server in tmux (`bun run web` for Kintsugi), then:

```sh
tmux new-session -d -s ios-serve-sim-forward -c /work \
  'bun tools/ios-serve-sim/cli.ts forward 3000 43000'
```

Open `http://localhost:43000/` in **simulator Safari** using the viewer, or upstream's authenticated `/exec` endpoint with `xcrun simctl openurl <udid> <url>`. Forwarding alone does not navigate Safari. Keep the viewer as the primary preview so the user can interact with the device.

## Operate through upstream

```sh
bun tools/ios-serve-sim/cli.ts exec --help
bun tools/ios-serve-sim/cli.ts exec --list -q
bun tools/ios-serve-sim/cli.ts exec tap 0.5 0.5 -d <udid>
bun tools/ios-serve-sim/cli.ts exec type "Hello" -d <udid>
bun tools/ios-serve-sim/cli.ts exec button home -d <udid>
bun tools/ios-serve-sim/cli.ts exec rotate landscape_left -d <udid>
```

- Discover the owned UDID from `--list -q`; use UDIDs, not assumed device-name support.
- Coordinates are normalized **0–1**, not pixels. Use `tap` for taps. For continuous gestures, use one upstream WebSocket rather than separate SSH invocations for each phase.
- Discover endpoints from the running viewer's `/api`; don't assume helper port 3100 or copy stale protocol recipes. Check the installed CLI's help for other operations.
- File arguments refer to the **remote Mac**, not the workspace or user's Mac.

## Ownership and cleanup

Never bypass the wrapper with raw `npx serve-sim`, detached startup, or global cleanup. Don't boot, shut down, or delete other workspaces' devices through the shared viewer.

Leave the viewer running when handing it to the user. Stopping it deletes its simulator and managed files, including site data. Workspace deletion also triggers cleanup; lost heartbeats start cleanup after 45 seconds. Explicit exports outside the managed directory are not cleaned up. The Mac account is shared, not sandboxed; only share the viewer with trusted users.

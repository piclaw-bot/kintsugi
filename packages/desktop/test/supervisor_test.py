import importlib.util
from importlib.machinery import SourceFileLoader
from pathlib import Path
import signal
import sys
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

# The deployed tools directory contains only executable files.
sys.dont_write_bytecode = True
loader = SourceFileLoader("desktop", str(Path(__file__).parent.parent / "workspace_tools/kintsugi-desktop"))
spec = importlib.util.spec_from_loader(loader.name, loader)
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = patch.object(desktop, "ROOT", Path(self.directory.name))
        self.root.start()
        self.addCleanup(self.root.stop)

    def test_absent_runtime_is_stopped(self):
        self.assertEqual(desktop.request_status(), {"phase": "stopped"})

    def test_previous_failure_remains_visible(self):
        (desktop.ROOT / "error.json").write_text('{"phase":"failed","error":"Xvfb exited"}')
        self.assertEqual(desktop.request_status()["error"], "Xvfb exited")

    def test_live_lock_without_ready_socket_is_starting(self):
        with open(desktop.ROOT / "runtime.lock", "w") as lock:
            desktop.fcntl.flock(lock, desktop.fcntl.LOCK_EX)
            self.assertEqual(desktop.request_status(), {"phase": "starting"})

    def test_repeated_start_reuses_supervisor(self):
        running = {"phase": "running", "pid": 123, **desktop.DETAILS}
        with patch.object(desktop, "request_status", return_value=running), patch.object(subprocess, "Popen") as spawn:
            self.assertEqual(desktop.start(), running)
            self.assertEqual(desktop.start(), running)
            spawn.assert_not_called()

    def test_child_failure_is_not_silently_restarted(self):
        child = Mock()
        child.poll.return_value = 7
        with self.assertRaisesRegex(RuntimeError, "Chromium exited with code 7"):
            desktop.assert_children([("Chromium", child)])

    def test_chromium_launch_disables_namespace_sandbox_in_workspace(self):
        read_fd, write_fd = desktop.os.pipe()
        with desktop.os.fdopen(read_fd) as result, \
                patch.object(desktop, "CDP_PORT", 0), \
                patch.object(desktop, "VNC_PORT", 0), \
                patch.object(desktop, "WEB_PORT", 0), \
                patch.object(subprocess, "run"), \
                patch.object(subprocess, "Popen") as spawn, \
                patch.object(desktop, "wait_ready", side_effect=[None, None, RuntimeError("probe stopped")]), \
                patch.object(desktop, "stop_children"):
            desktop.supervise(write_fd)
            chromium = spawn.call_args_list[2].args[0]
            self.assertEqual(chromium[:3], ["dbus-run-session", "--", "/opt/kintsugi/bin/chromium"])
            self.assertIn("--no-sandbox", chromium)
            self.assertIn("--remote-debugging-address=127.0.0.1", chromium)
            self.assertIn('"phase": "failed"', result.read())

    def test_cleanup_terminates_all_owned_groups_in_reverse_order(self):
        children = [("Xvfb", Mock(pid=100)), ("Chromium", Mock(pid=200))]
        with patch.object(desktop.os, "killpg") as kill:
            desktop.stop_children(children)
            self.assertEqual(kill.call_args_list, [unittest.mock.call(200, signal.SIGTERM), unittest.mock.call(100, signal.SIGTERM)])
        for _, child in children:
            child.wait.assert_called_once()

    def test_cleanup_escalates_unresponsive_child(self):
        child = Mock(pid=100)
        child.wait.side_effect = [subprocess.TimeoutExpired("Xvfb", 3), 0]
        with patch.object(desktop.os, "killpg") as kill:
            desktop.stop_children([("Xvfb", child)])
            self.assertEqual(kill.call_args_list[-1], unittest.mock.call(100, signal.SIGKILL))

    def test_closed_control_socket_after_workspace_restart_is_stopped(self):
        with socket.socket(socket.AF_UNIX) as control:
            control.bind(str(desktop.ROOT / "control.sock"))
        self.assertEqual(desktop.request_status(), {"phase": "stopped"})


if __name__ == "__main__":
    unittest.main()

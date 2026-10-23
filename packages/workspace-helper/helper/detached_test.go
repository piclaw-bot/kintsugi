package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "kintsugi/workspace-helper/workspacehelperv1"
)

func detached(name string, stdin bool) *pb.ExecStart_Detached {
	return &pb.ExecStart_Detached{Detached: &pb.Detached{Name: name, Stdin: stdin}}
}

// Starts a detached process and leaves its call open; cancel the context to leave it running.
func startDetached(t *testing.T, ctx context.Context, helper pb.WorkspaceHelperClient, name string, stdin bool, argv ...string) pb.WorkspaceHelper_ExecClient {
	t.Helper()
	stream, err := helper.Exec(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := stream.Send(&pb.ExecRequest{Request: &pb.ExecRequest_Start{Start: &pb.ExecStart{Argv: argv, Stdio: detached(name, stdin), User: pb.User_USER_AGENT, Workdir: t.TempDir()}}}); err != nil {
		t.Fatal(err)
	}
	return stream
}

func attach(t *testing.T, ctx context.Context, helper pb.WorkspaceHelperClient, name string, stdout, stderr uint64, requests ...*pb.AttachRequest) pb.WorkspaceHelper_AttachClient {
	t.Helper()
	stream, err := helper.Attach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, request := range append([]*pb.AttachRequest{{Request: &pb.AttachRequest_Attach{Attach: &pb.Attach{Name: name, StdoutOffset: stdout, StderrOffset: stderr}}}}, requests...) {
		if err := stream.Send(request); err != nil {
			t.Fatal(err)
		}
	}
	return stream
}

func stdinRequest(data string) *pb.AttachRequest {
	return &pb.AttachRequest{Request: &pb.AttachRequest_Stdin{Stdin: []byte(data)}}
}

func signalRequest(signal pb.Signal) *pb.AttachRequest {
	return &pb.AttachRequest{Request: &pb.AttachRequest_Signal{Signal: signal}}
}

// Reads stdout until it has `want`, which must be how it starts.
func readStdout(t *testing.T, stream responses, want string) {
	t.Helper()
	got := ""
	for len(got) < len(want) {
		response, err := stream.Recv()
		if err != nil {
			t.Fatalf("after %q: %v", got, err)
		}
		got += string(response.GetStdout())
	}
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// Waits until the helper has recorded the process, without attaching, which could consume its exit.
func waitForDetached(t *testing.T, state, name string) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if _, err := os.Stat(filepath.Join(state, name, "process")); err == nil {
			return
		}
	}
	t.Fatalf("%s never started", name)
}

func TestDetachedProcessOutlivesItsCall(t *testing.T) {
	helper := client(t)
	ctx, cancel := context.WithCancel(context.Background())
	readStdout(t, startDetached(t, ctx, helper, "agent:1", true, "sh", "-c", "echo started; read line; echo got:$line"), "started\n")
	cancel()
	got, err := collect(t, attach(t, context.Background(), helper, "agent:1", uint64(len("started\n")), 0, stdinRequest("hi\n")))
	if err != nil {
		t.Fatal(err)
	}
	if got.stdout != "got:hi\n" || got.exited.GetExitCode() != 0 {
		t.Fatalf("got %+v", got)
	}
	if _, err := attach(t, context.Background(), helper, "agent:1", 0, 0).Recv(); status.Code(err) != codes.NotFound {
		t.Fatalf("a reported process can still be attached: %v", err)
	}
}

func TestOutputWrittenWhileDetachedIsReplayed(t *testing.T) {
	state := t.TempDir()
	helper := clientWithState(t, state)
	ctx, cancel := context.WithCancel(context.Background())
	startDetached(t, ctx, helper, "late", false, "sh", "-c", "sleep 0.3; echo late; echo oops >&2")
	waitForDetached(t, state, "late")
	cancel()
	time.Sleep(600 * time.Millisecond)
	got, err := collect(t, attach(t, context.Background(), helper, "late", 0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if got.stdout != "late\n" || got.stderr != "oops\n" || got.exited.GetExitCode() != 0 {
		t.Fatalf("got %+v", got)
	}
}

func TestOutputStreamsWithoutWaitingForANewline(t *testing.T) {
	helper := client(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream := startDetached(t, ctx, helper, "partial", true, "cat")
	for _, chunk := range []string{"a", "b", "c"} {
		if err := stream.Send(&pb.ExecRequest{Request: &pb.ExecRequest_Stdin{Stdin: []byte(chunk)}}); err != nil {
			t.Fatal(err)
		}
		readStdout(t, stream, chunk)
	}
	stream.Send(&pb.ExecRequest{Request: &pb.ExecRequest_Signal{Signal: pb.Signal_SIGNAL_KILL}})
	if _, err := collect(t, stream); err != nil {
		t.Fatal(err)
	}
}

func TestRestartedHelperFindsTheProcess(t *testing.T) {
	state := t.TempDir()
	first := clientWithState(t, state)
	ctx, cancel := context.WithCancel(context.Background())
	startDetached(t, ctx, first, "echo", true, "sh", "-c", echoLines)
	waitForDetached(t, state, "echo")
	cancel()

	second := clientWithState(t, state)
	stream := attach(t, context.Background(), second, "echo", 0, 0, stdinRequest("hello\n"))
	readStdout(t, stream, "hello\n")
	if err := stream.Send(signalRequest(pb.Signal_SIGNAL_TERM)); err != nil {
		t.Fatal(err)
	}
	got, err := collect(t, stream)
	if err != nil {
		t.Fatal(err)
	}
	// The first helper, still its parent here, reaped it; the second can't know how it ended.
	if got.exited.GetUnknown() == nil {
		t.Fatalf("got %+v", got.exited)
	}
}

func TestStartupRemovesWhatFinishedProcessesLeft(t *testing.T) {
	state := t.TempDir()
	first := clientWithState(t, state)
	ctx, cancel := context.WithCancel(context.Background())
	// Exits after the call ends, so no call reports it.
	startDetached(t, ctx, first, "brief", false, "sleep", "0.3")
	waitForDetached(t, state, "brief")
	cancel()
	time.Sleep(600 * time.Millisecond)

	second := clientWithState(t, state)
	if _, err := attach(t, context.Background(), second, "brief", 0, 0).Recv(); status.Code(err) != codes.NotFound {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(filepath.Join(state, "brief")); !os.IsNotExist(err) {
		t.Fatalf("its state is still there: %v", err)
	}
}

func TestNamesAreUniqueWhileRunning(t *testing.T) {
	state := t.TempDir()
	helper := clientWithState(t, state)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	startDetached(t, ctx, helper, "sleeper", false, "sleep", "30")
	waitForDetached(t, state, "sleeper")
	if _, err := startDetached(t, context.Background(), helper, "sleeper", false, "true").Recv(); status.Code(err) != codes.AlreadyExists {
		t.Fatalf("got %v", err)
	}
	got, err := collect(t, attach(t, context.Background(), helper, "sleeper", 0, 0, signalRequest(pb.Signal_SIGNAL_KILL)))
	if err != nil {
		t.Fatal(err)
	}
	if got.exited.GetSignal() != 9 {
		t.Fatalf("got %+v", got.exited)
	}
}

func TestAnExitedProcessIsReplaced(t *testing.T) {
	state := t.TempDir()
	helper := clientWithState(t, state)
	ctx, cancel := context.WithCancel(context.Background())
	// Exits after the call ends, leaving its output unread.
	startDetached(t, ctx, helper, "again", false, "sh", "-c", "sleep 0.3; echo one")
	waitForDetached(t, state, "again")
	cancel()
	time.Sleep(600 * time.Millisecond)
	stream := startDetached(t, context.Background(), helper, "again", false, "echo", "two")
	stream.CloseSend()
	got, err := collect(t, stream)
	if err != nil {
		t.Fatal(err)
	}
	if got.stdout != "two\n" {
		t.Fatalf("got %+v", got)
	}
}

func TestANewerCallDisplacesTheOlderOne(t *testing.T) {
	helper := client(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	older := startDetached(t, ctx, helper, "shared", true, "sh", "-c", "echo ready; "+echoLines)
	readStdout(t, older, "ready\n")
	newer := attach(t, context.Background(), helper, "shared", uint64(len("ready\n")), 0)
	if _, err := older.Recv(); status.Code(err) != codes.Aborted {
		t.Fatalf("got %v", err)
	}
	if err := newer.Send(stdinRequest("mine\n")); err != nil {
		t.Fatal(err)
	}
	readStdout(t, newer, "mine\n")
	newer.Send(signalRequest(pb.Signal_SIGNAL_KILL))
	if _, err := collect(t, newer); err != nil {
		t.Fatal(err)
	}
}

// Echoes each line it reads.
const echoLines = "while read -r line; do echo \"$line\"; done"

func TestAcknowledgedOutputIsFreed(t *testing.T) {
	state := t.TempDir()
	helper := clientWithState(t, state)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream := startDetached(t, ctx, helper, "chatty", true, "sh", "-c", "head -c 100000 /dev/zero | tr '\\0' a; "+echoLines)
	readStdout(t, stream, strings.Repeat("a", 100000))
	blocks := func() int64 {
		info, err := os.Stat(filepath.Join(state, "chatty", "stdout"))
		if err != nil {
			t.Fatal(err)
		}
		return info.Sys().(*syscall.Stat_t).Blocks
	}
	before := blocks()
	// The echo confirms the acknowledgement before it was applied.
	stream.Send(&pb.ExecRequest{Request: &pb.ExecRequest_Acknowledge{Acknowledge: &pb.Acknowledge{StdoutOffset: 60000}}})
	stream.Send(&pb.ExecRequest{Request: &pb.ExecRequest_Stdin{Stdin: []byte("x\n")}})
	readStdout(t, stream, "x\n")
	freed := blocks()
	if freed >= before {
		t.Fatalf("acknowledging left %d blocks, %d before", freed, before)
	}
	if _, err := attach(t, ctx, helper, "chatty", 0, 0).Recv(); status.Code(err) != codes.OutOfRange {
		t.Fatalf("attaching before the acknowledged offset: %v", err)
	}
	if _, err := attach(t, ctx, helper, "chatty", 200000, 0).Recv(); status.Code(err) != codes.OutOfRange {
		t.Fatalf("attaching beyond the output: %v", err)
	}
	// Attaching from an offset acknowledges the output before it, too.
	readStdout(t, attach(t, ctx, helper, "chatty", 100002, 0, stdinRequest("y\n")), "y\n")
	if after := blocks(); after >= freed {
		t.Fatalf("attaching left %d blocks, %d before", after, freed)
	}
	if _, err := attach(t, ctx, helper, "chatty", 70000, 0).Recv(); status.Code(err) != codes.OutOfRange {
		t.Fatalf("attaching before an offset an attach acknowledged: %v", err)
	}
	if _, err := attach(t, ctx, helper, "chatty", 100004, 0, &pb.AttachRequest{Request: &pb.AttachRequest_Acknowledge{Acknowledge: &pb.Acknowledge{StdoutOffset: 90000}}}).Recv(); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("acknowledging backwards: %v", err)
	}
	got, err := collect(t, attach(t, ctx, helper, "chatty", 100004, 0, signalRequest(pb.Signal_SIGNAL_KILL)))
	if err != nil {
		t.Fatal(err)
	}
	if got.exited.GetSignal() != 9 {
		t.Fatalf("got %+v", got.exited)
	}
}

func TestDetachedProcessesRejectInvalidRequests(t *testing.T) {
	helper := client(t)
	for _, name := range []string{"../escape", ".hidden", "", strings.Repeat("a", 129)} {
		if _, err := run(t, context.Background(), helper, &pb.ExecStart{Argv: []string{"true"}, Stdio: detached(name, false)}); status.Code(err) != codes.InvalidArgument {
			t.Fatalf("%q: got %v", name, err)
		}
	}
	_, err := run(t, context.Background(), helper, &pb.ExecStart{Argv: []string{"cat"}, Stdio: detached("open", true)},
		&pb.ExecRequest{Request: &pb.ExecRequest_CloseStdin{CloseStdin: &pb.CloseStdin{}}})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("close_stdin: got %v", err)
	}
	collect(t, attach(t, context.Background(), helper, "open", 0, 0, signalRequest(pb.Signal_SIGNAL_KILL)))
	_, err = run(t, context.Background(), helper, &pb.ExecStart{Argv: []string{"sleep", "5"}},
		&pb.ExecRequest{Request: &pb.ExecRequest_Acknowledge{Acknowledge: &pb.Acknowledge{}}})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("acknowledge with pipes: got %v", err)
	}
}

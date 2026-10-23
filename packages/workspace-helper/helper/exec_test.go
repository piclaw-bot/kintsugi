package main

import (
	"context"
	"io"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "kintsugi/workspace-helper/workspacehelperv1"
)

func client(t *testing.T) pb.WorkspaceHelperClient {
	t.Helper()
	return clientWithState(t, t.TempDir())
}

// A helper keeping detached processes in state, which a later helper can share as if it restarted.
func clientWithState(t *testing.T, state string) pb.WorkspaceHelperClient {
	t.Helper()
	current, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	detached, err := openRegistry(state)
	if err != nil {
		t.Fatal(err)
	}
	// Detached processes outlive their calls, and would outlive a failed test too.
	t.Cleanup(func() {
		detached.mu.Lock()
		defer detached.mu.Unlock()
		for _, process := range detached.processes {
			syscall.Kill(-process.pid, syscall.SIGKILL)
		}
	})
	return serve(t, &helper{users: map[pb.User]string{pb.User_USER_AGENT: current.Username}, detached: detached})
}

func serve(t *testing.T, implementation *helper) pb.WorkspaceHelperClient {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "helper.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	pb.RegisterWorkspaceHelperServer(server, implementation)
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	connection, err := grpc.NewClient("unix://"+socket, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { connection.Close() })
	return pb.NewWorkspaceHelperClient(connection)
}

var pipesWithStdin = &pb.ExecStart_Pipes{Pipes: &pb.Pipes{Stdin: true}}

// Exec and Attach calls both answer with ExecResponses.
type responses interface {
	Recv() (*pb.ExecResponse, error)
}

type result struct {
	stdout, stderr string
	exited         *pb.Exited
}

func collect(t *testing.T, stream responses) (result, error) {
	t.Helper()
	var collected result
	for {
		response, err := stream.Recv()
		if err == io.EOF {
			if collected.exited == nil {
				t.Fatal("the stream ended without exited")
			}
			return collected, nil
		}
		if err != nil {
			return collected, err
		}
		if collected.exited != nil {
			t.Fatalf("response after exited: %v", response)
		}
		switch response := response.Response.(type) {
		case *pb.ExecResponse_Stdout:
			collected.stdout += string(response.Stdout)
		case *pb.ExecResponse_Stderr:
			collected.stderr += string(response.Stderr)
		case *pb.ExecResponse_Exited:
			collected.exited = response.Exited
		}
	}
}

func run(t *testing.T, ctx context.Context, helper pb.WorkspaceHelperClient, start *pb.ExecStart, requests ...*pb.ExecRequest) (result, error) {
	t.Helper()
	stream, err := helper.Exec(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if start.User == pb.User_USER_UNSPECIFIED {
		start.User = pb.User_USER_AGENT
	}
	if start.Workdir == "" {
		start.Workdir = t.TempDir()
	}
	if start.Stdio == nil {
		start.Stdio = &pb.ExecStart_Pipes{Pipes: &pb.Pipes{}}
	}
	for _, request := range append([]*pb.ExecRequest{{Request: &pb.ExecRequest_Start{Start: start}}}, requests...) {
		if err := stream.Send(request); err != nil {
			t.Fatal(err)
		}
	}
	if err := stream.CloseSend(); err != nil {
		t.Fatal(err)
	}
	return collect(t, stream)
}

func TestSeparatesOutputAndReportsExitCode(t *testing.T) {
	got, err := run(t, context.Background(), client(t), &pb.ExecStart{Argv: []string{"sh", "-c", `printf out; printf err >&2; printf "$GREETING"; pwd >&2; exit 7`}, Env: map[string]string{"GREETING": "!"}, Workdir: "/tmp"})
	if err != nil {
		t.Fatal(err)
	}
	if got.stdout != "out!" || got.stderr != "err/tmp\n" || got.exited.GetExitCode() != 7 {
		t.Fatalf("got %+v", got)
	}
}

func TestStdinEndsWhenTheRequestStreamCloses(t *testing.T) {
	got, err := run(t, context.Background(), client(t), &pb.ExecStart{Argv: []string{"cat"}, Stdio: pipesWithStdin},
		&pb.ExecRequest{Request: &pb.ExecRequest_Stdin{Stdin: []byte("hello ")}},
		&pb.ExecRequest{Request: &pb.ExecRequest_Stdin{Stdin: []byte("world")}})
	if err != nil {
		t.Fatal(err)
	}
	if got.stdout != "hello world" || got.exited.GetExitCode() != 0 {
		t.Fatalf("got %+v", got)
	}
}

func TestWithoutStdinTheProcessReadsDevNull(t *testing.T) {
	got, err := run(t, context.Background(), client(t), &pb.ExecStart{Argv: []string{"sh", "-c", "cat; echo done"}})
	if err != nil {
		t.Fatal(err)
	}
	if got.stdout != "done\n" {
		t.Fatalf("got %+v", got)
	}
}

func TestStdinWithoutAPipeFails(t *testing.T) {
	_, err := run(t, context.Background(), client(t), &pb.ExecStart{Argv: []string{"sleep", "5"}},
		&pb.ExecRequest{Request: &pb.ExecRequest_Stdin{Stdin: []byte("x")}})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("got %v", err)
	}
}

func TestMissingExecutableIsNotFound(t *testing.T) {
	_, err := run(t, context.Background(), client(t), &pb.ExecStart{Argv: []string{"kintsugi-does-not-exist"}})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("got %v", err)
	}
}

func TestFirstRequestMustBeStart(t *testing.T) {
	stream, err := client(t).Exec(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	stream.Send(&pb.ExecRequest{Request: &pb.ExecRequest_CloseStdin{CloseStdin: &pb.CloseStdin{}}})
	if _, err := stream.Recv(); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("got %v", err)
	}
}

func TestSignalReachesTheProcessGroup(t *testing.T) {
	got, err := run(t, context.Background(), client(t), &pb.ExecStart{Argv: []string{"sh", "-c", "sleep 30"}},
		&pb.ExecRequest{Request: &pb.ExecRequest_Signal{Signal: pb.Signal_SIGNAL_TERM}})
	if err != nil {
		t.Fatal(err)
	}
	if got.exited.GetSignal() != 15 {
		t.Fatalf("got %+v", got)
	}
}

func TestCancellingKillsTheProcessGroup(t *testing.T) {
	directory := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	stream, err := client(t).Exec(ctx)
	if err != nil {
		t.Fatal(err)
	}
	stream.Send(&pb.ExecRequest{Request: &pb.ExecRequest_Start{Start: &pb.ExecStart{
		User: pb.User_USER_AGENT, Workdir: directory, Stdio: &pb.ExecStart_Pipes{Pipes: &pb.Pipes{}},
		Argv: []string{"sh", "-c", "(sleep 1; touch late) & touch started; wait"},
	}}})
	for {
		if _, err := os.Stat(filepath.Join(directory, "started")); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if _, err := stream.Recv(); err == nil {
		for err == nil {
			_, err = stream.Recv()
		}
	}
	time.Sleep(1500 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(directory, "late")); err == nil {
		t.Fatal("a cancelled process's child kept running")
	}
}

func TestTerminal(t *testing.T) {
	got, err := run(t, context.Background(), client(t), &pb.ExecStart{
		Argv:  []string{"sh", "-c", "stty size; read line; echo got:$line; stty size"},
		Stdio: &pb.ExecStart_Terminal{Terminal: &pb.TerminalSize{Cols: 80, Rows: 24}},
	},
		&pb.ExecRequest{Request: &pb.ExecRequest_Resize{Resize: &pb.TerminalSize{Cols: 100, Rows: 30}}},
		&pb.ExecRequest{Request: &pb.ExecRequest_Stdin{Stdin: []byte("hi\n")}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got.stdout, "got:hi") || !strings.HasSuffix(got.stdout, "30 100\r\n") || got.stderr != "" {
		t.Fatalf("got %q", got.stdout)
	}
}

func TestStartMustSayHowToConnectStdio(t *testing.T) {
	stream, err := client(t).Exec(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	stream.Send(&pb.ExecRequest{Request: &pb.ExecRequest_Start{Start: &pb.ExecStart{Argv: []string{"true"}, User: pb.User_USER_AGENT}}})
	if _, err := stream.Recv(); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("got %v", err)
	}
}

func TestSystemdBookkeepingIsNotInherited(t *testing.T) {
	t.Setenv("JOURNAL_STREAM", "8:1234")
	got, err := run(t, context.Background(), client(t), &pb.ExecStart{Argv: []string{"sh", "-c", `printf "%s|%s" "${JOURNAL_STREAM-unset}" "$HOME"`}})
	if err != nil {
		t.Fatal(err)
	}
	current, _ := user.Current()
	if got.stdout != "unset|"+current.HomeDir {
		t.Fatalf("got %q", got.stdout)
	}
}

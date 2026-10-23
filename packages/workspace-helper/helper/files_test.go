package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "kintsugi/workspace-helper/workspacehelperv1"
)

func readFile(helper pb.WorkspaceHelperClient, as pb.User, path string) ([]byte, error) {
	stream, err := helper.ReadFile(context.Background(), &pb.ReadFileRequest{User: as, Path: path})
	if err != nil {
		return nil, err
	}
	var content []byte
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			return content, nil
		}
		if err != nil {
			return nil, err
		}
		content = append(content, chunk.Data...)
	}
}

func writeFile(t *testing.T, helper pb.WorkspaceHelperClient, as pb.User, path string, chunks ...string) error {
	t.Helper()
	stream, err := helper.WriteFile(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	stream.Send(&pb.WriteFileRequest{Request: &pb.WriteFileRequest_Start{Start: &pb.WriteFileStart{User: as, Path: path}}})
	for _, chunk := range chunks {
		stream.Send(&pb.WriteFileRequest{Request: &pb.WriteFileRequest_Data{Data: []byte(chunk)}})
	}
	_, err = stream.CloseAndRecv()
	return err
}

func expectCode(t *testing.T, err error, code codes.Code) {
	t.Helper()
	if status.Code(err) != code {
		t.Fatalf("got %v, want %v", err, code)
	}
}

func expectContent(t *testing.T, path string, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Fatalf("%s has %q, want %q", path, got, want)
	}
}

func TestReadsAFileInChunks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "large")
	content := bytes.Repeat([]byte("0123456789"), fileChunkBytes/4)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := readFile(client(t), pb.User_USER_AGENT, path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("read %d bytes, want %d", len(got), len(content))
	}
}

func TestReadsOnlyRegularFiles(t *testing.T) {
	directory := t.TempDir()
	fifo := filepath.Join(directory, "fifo")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Fatal(err)
	}
	unreadable := filepath.Join(directory, "unreadable")
	if err := os.WriteFile(unreadable, nil, 0); err != nil {
		t.Fatal(err)
	}
	helper := client(t)
	for path, code := range map[string]codes.Code{
		filepath.Join(directory, "missing"): codes.NotFound,
		directory:                           codes.FailedPrecondition,
		fifo:                                codes.FailedPrecondition,
		"/dev/urandom":                      codes.FailedPrecondition,
		"relative":                          codes.InvalidArgument,
	} {
		_, err := readFile(helper, pb.User_USER_AGENT, path)
		expectCode(t, err, code)
	}
	if os.Geteuid() != 0 {
		_, err := readFile(helper, pb.User_USER_AGENT, unreadable)
		expectCode(t, err, codes.PermissionDenied)
	}
}

func TestWritesANewFileAndItsFolders(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a", "b", "new")
	if err := writeFile(t, client(t), pb.User_USER_AGENT, path, "hello ", "world"); err != nil {
		t.Fatal(err)
	}
	expectContent(t, path, "hello world")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Fatalf("mode %v", info.Mode())
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("left behind %v", entries)
	}
}

func TestReplacingKeepsTheModeAndFollowsSymlinks(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "target")
	if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "link")
	if err := os.Symlink("target", link); err != nil {
		t.Fatal(err)
	}
	if err := writeFile(t, client(t), pb.User_USER_AGENT, link, "new"); err != nil {
		t.Fatal(err)
	}
	expectContent(t, target, "new")
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("link became %v, %v", info, err)
	}
	if info, err := os.Stat(target); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("target became %v, %v", info, err)
	}
}

func TestRefusesToReplaceWhatItCannot(t *testing.T) {
	directory := t.TempDir()
	helper := client(t)
	expectCode(t, writeFile(t, helper, pb.User_USER_AGENT, directory, "x"), codes.FailedPrecondition)
	expectCode(t, writeFile(t, helper, pb.User_USER_AGENT, "relative", "x"), codes.InvalidArgument)
	if os.Geteuid() != 0 {
		readOnly := filepath.Join(directory, "read-only")
		if err := os.WriteFile(readOnly, []byte("kept"), 0o444); err != nil {
			t.Fatal(err)
		}
		expectCode(t, writeFile(t, helper, pb.User_USER_AGENT, readOnly, "x"), codes.PermissionDenied)
		expectContent(t, readOnly, "kept")
	}
}

func TestACancelledWriteLeavesTheFileAlone(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "file")
	if err := os.WriteFile(path, []byte("kept"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	stream, err := client(t).WriteFile(ctx)
	if err != nil {
		t.Fatal(err)
	}
	stream.Send(&pb.WriteFileRequest{Request: &pb.WriteFileRequest_Start{Start: &pb.WriteFileStart{User: pb.User_USER_AGENT, Path: path}}})
	stream.Send(&pb.WriteFileRequest{Request: &pb.WriteFileRequest_Data{Data: []byte("partial")}})
	cancel()
	expectCode(t, func() error { _, err := stream.CloseAndRecv(); return err }(), codes.Canceled)
	// The helper notices the cancellation on its own schedule.
	for attempt := 0; ; attempt++ {
		entries, err := os.ReadDir(directory)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) == 1 {
			break
		}
		if attempt == 100 {
			t.Fatalf("left behind %v", entries)
		}
		syscall.Nanosleep(&syscall.Timespec{Nsec: 10_000_000}, nil)
	}
	expectContent(t, path, "kept")
}

// Needs root, e.g. `sudo go test -run TestFilesUseTheUsersPermissions`.
func TestFilesUseTheUsersPermissions(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("switching users needs root")
	}
	nobody, err := user.Lookup("nobody")
	if err != nil {
		t.Fatal(err)
	}
	uid, _ := strconv.Atoi(nobody.Uid)
	helper := serve(t, &helper{users: map[pb.User]string{pb.User_USER_AGENT: "nobody", pb.User_USER_ROOT: "root"}, switchUser: true})

	secret := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(secret, []byte("root only"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = readFile(helper, pb.User_USER_AGENT, secret)
	expectCode(t, err, codes.PermissionDenied)
	expectCode(t, writeFile(t, helper, pb.User_USER_AGENT, secret, "x"), codes.PermissionDenied)
	// The identity stays on its own thread.
	if got, err := readFile(helper, pb.User_USER_ROOT, secret); err != nil || string(got) != "root only" {
		t.Fatalf("root read %q, %v", got, err)
	}

	shared := t.TempDir()
	for path := shared; path != os.TempDir(); path = filepath.Dir(path) {
		if err := os.Chmod(path, 0o777); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(shared, "folder", "file")
	if err := writeFile(t, helper, pb.User_USER_AGENT, path, "mine"); err != nil {
		t.Fatal(err)
	}
	for _, created := range []string{path, filepath.Dir(path)} {
		info, err := os.Stat(created)
		if err != nil {
			t.Fatal(err)
		}
		if owner := info.Sys().(*syscall.Stat_t).Uid; int(owner) != uid {
			t.Fatalf("%s belongs to %d, want %d", created, owner, uid)
		}
	}
}

func TestStatsFilesWithoutReadingThem(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "file")
	if err := os.WriteFile(file, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "link")
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	dangling := filepath.Join(directory, "dangling")
	if err := os.Symlink(filepath.Join(directory, "missing"), dangling); err != nil {
		t.Fatal(err)
	}
	unreadable := filepath.Join(directory, "unreadable")
	if err := os.WriteFile(unreadable, nil, 0); err != nil {
		t.Fatal(err)
	}
	locked := filepath.Join(directory, "locked")
	if err := os.Mkdir(locked, 0); err != nil {
		t.Fatal(err)
	}
	modified := time.UnixMilli(1_700_000_000_000)
	if err := os.Chtimes(file, modified, modified); err != nil {
		t.Fatal(err)
	}
	type want struct {
		kind              pb.FileKind
		symlink, readable bool
		size              uint64
	}
	type statCase struct {
		path string
		want want
	}
	cases := []statCase{
		{file, want{kind: pb.FileKind_FILE_KIND_REGULAR, readable: true, size: 5}},
		{link, want{kind: pb.FileKind_FILE_KIND_REGULAR, symlink: true, readable: true, size: 5}},
		{directory, want{kind: pb.FileKind_FILE_KIND_DIRECTORY, readable: true}},
		{"/dev/null", want{kind: pb.FileKind_FILE_KIND_OTHER}},
		{filepath.Join(directory, "missing"), want{kind: pb.FileKind_FILE_KIND_MISSING}},
		{dangling, want{kind: pb.FileKind_FILE_KIND_MISSING}},
		{filepath.Join(file, "below"), want{kind: pb.FileKind_FILE_KIND_MISSING}},
	}
	// Root may read and look into anything.
	if os.Geteuid() != 0 {
		cases = append(cases,
			statCase{unreadable, want{kind: pb.FileKind_FILE_KIND_REGULAR}},
			statCase{filepath.Join(locked, "file"), want{kind: pb.FileKind_FILE_KIND_INACCESSIBLE}})
	}
	paths := make([]string, len(cases))
	for index, c := range cases {
		paths[index] = c.path
	}
	helper := client(t)
	response, err := helper.StatFiles(context.Background(), &pb.StatFilesRequest{User: pb.User_USER_AGENT, Paths: paths})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Stats) != len(cases) {
		t.Fatalf("got %d stats for %d paths", len(response.Stats), len(cases))
	}
	for index, c := range cases {
		stat := response.Stats[index]
		got := want{kind: stat.Kind, symlink: stat.Symlink, readable: stat.Readable}
		if c.want.kind == pb.FileKind_FILE_KIND_REGULAR {
			got.size = stat.Size
		}
		if got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.path, got, c.want)
		}
	}
	if got := response.Stats[0].ModifiedUnixMs; got != modified.UnixMilli() {
		t.Errorf("modified %d, want %d", got, modified.UnixMilli())
	}
	_, err = helper.StatFiles(context.Background(), &pb.StatFilesRequest{User: pb.User_USER_AGENT, Paths: []string{file, "relative"}})
	expectCode(t, err, codes.InvalidArgument)
}

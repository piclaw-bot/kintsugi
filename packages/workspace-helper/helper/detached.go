package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "kintsugi/workspace-helper/workspacehelperv1"
)

// Detached processes outlive the calls that start them and the helper itself.
// Each keeps its state in a directory of its own, which only root can open:
//
//	process       "<pid> <start time>", to find the process again after a helper restart
//	stdout        the process writes its output here directly
//	stderr
//	stdin         a FIFO the process holds open for reading and writing, so it never sees EOF
//	acknowledged  "<stdout offset> <stderr offset>" the client no longer needs

var namePattern = regexp.MustCompile(`^[A-Za-z0-9_:-][A-Za-z0-9._:-]{0,127}$`)

// The two output files, in the order offsets use.
var outputFiles = [2]string{"stdout", "stderr"}

// fallocate frees whole blocks only.
const punchAlignment = 4096

type detachedProcess struct {
	name, directory string
	pid             int
	// The FIFO's write end; nil without stdin.
	stdin  *os.File
	exited chan struct{}
	// Set before exited closes.
	status *pb.Exited

	mu sync.Mutex
	// The call streaming the process's output, if any.
	attachment   *attachment
	acknowledged [2]int64
	// Keeps writes from two calls apart without making a new call wait for a blocked write.
	writing sync.Mutex
}

type attachment struct {
	end context.CancelCauseFunc
}

type registry struct {
	directory string
	mu        sync.Mutex
	processes map[string]*detachedProcess
}

// Opens the state directory, finding processes that outlived a previous helper
// and removing what is left of those that didn't.
func openRegistry(directory string) (*registry, error) {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	r := &registry{directory: directory, processes: map[string]*detachedProcess{}}
	for _, entry := range entries {
		process, err := adopt(filepath.Join(directory, entry.Name()), entry.Name())
		if err != nil {
			return nil, err
		}
		if process == nil {
			if err := os.RemoveAll(filepath.Join(directory, entry.Name())); err != nil {
				return nil, err
			}
			continue
		}
		r.processes[entry.Name()] = process
	}
	return r, nil
}

// Field 22 of /proc/<pid>/stat: with the pid, it identifies a process even after the pid is reused.
func startTime(pid int) (string, error) {
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", err
	}
	// The command name, in parentheses, may contain spaces.
	fields := strings.Fields(string(stat[strings.LastIndexByte(string(stat), ')')+1:]))
	return fields[19], nil
}

func readOffsets(path string) ([2]int64, error) {
	var offsets [2]int64
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return offsets, nil
	}
	if err != nil {
		return offsets, err
	}
	_, err = fmt.Sscanf(string(data), "%d %d", &offsets[0], &offsets[1])
	return offsets, err
}

// Returns nil when the process recorded in directory is gone.
func adopt(directory, name string) (*detachedProcess, error) {
	if !namePattern.MatchString(name) {
		return nil, nil
	}
	recorded, err := os.ReadFile(filepath.Join(directory, "process"))
	if os.IsNotExist(err) {
		// The helper stopped before recording the process.
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var pid int
	var started string
	if _, err := fmt.Sscanf(string(recorded), "%d %s", &pid, &started); err != nil {
		return nil, fmt.Errorf("read %s: %w", filepath.Join(directory, "process"), err)
	}
	pidfd, err := unix.PidfdOpen(pid, 0)
	if errors.Is(err, unix.ESRCH) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// Checked after opening, so the pidfd is known to refer to the recorded process.
	if current, err := startTime(pid); err != nil || current != started {
		unix.Close(pidfd)
		return nil, nil
	}
	acknowledged, err := readOffsets(filepath.Join(directory, "acknowledged"))
	if err != nil {
		unix.Close(pidfd)
		return nil, err
	}
	process := &detachedProcess{name: name, directory: directory, pid: pid, exited: make(chan struct{}), acknowledged: acknowledged}
	if _, err := os.Stat(filepath.Join(directory, "stdin")); err == nil {
		// Non-blocking, so this fails instead of hanging when nothing reads the FIFO.
		process.stdin, err = os.OpenFile(filepath.Join(directory, "stdin"), os.O_WRONLY|syscall.O_NONBLOCK, 0)
		if err != nil {
			log.Printf("detached process %s: stdin is unavailable: %v", name, err)
		}
	}
	go func() {
		defer unix.Close(pidfd)
		descriptors := []unix.PollFd{{Fd: int32(pidfd), Events: unix.POLLIN}}
		for {
			if _, err := unix.Poll(descriptors, -1); !errors.Is(err, unix.EINTR) {
				break
			}
		}
		// The process's parent, no longer this helper, reaped it.
		process.status = &pb.Exited{Status: &pb.Exited_Unknown{Unknown: &pb.Unknown{}}}
		close(process.exited)
	}()
	return process, nil
}

func (r *registry) start(start *pb.ExecStart, account identity, switchUser bool) (*detachedProcess, error) {
	detached := start.GetDetached()
	if !namePattern.MatchString(detached.Name) {
		return nil, status.Errorf(codes.InvalidArgument, "invalid process name %q", detached.Name)
	}
	command, err := newCommand(start, account, switchUser)
	if err != nil {
		return nil, err
	}
	command.SysProcAttr.Setpgid = true
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing := r.processes[detached.Name]; existing != nil {
		select {
		case <-existing.exited:
			existing.detach(status.Error(codes.Aborted, "the process was replaced"))
			delete(r.processes, detached.Name)
			if existing.stdin != nil {
				existing.stdin.Close()
			}
		default:
			return nil, status.Errorf(codes.AlreadyExists, "a process named %q is running", detached.Name)
		}
	}
	directory := filepath.Join(r.directory, detached.Name)
	if err := os.RemoveAll(directory); err != nil {
		return nil, err
	}
	if err := os.Mkdir(directory, 0o700); err != nil {
		return nil, err
	}
	process, err := launch(command, directory, detached)
	if err != nil {
		os.RemoveAll(directory)
		return nil, err
	}
	r.processes[detached.Name] = process
	return process, nil
}

// Starts command with its stdio in directory.
func launch(command *exec.Cmd, directory string, detached *pb.Detached) (*detachedProcess, error) {
	// The process's ends, which the helper closes once it has them.
	var childEnds []*os.File
	defer func() {
		for _, file := range childEnds {
			file.Close()
		}
	}()
	for index, name := range outputFiles {
		// Not O_APPEND: the process and its children share this one open file and
		// its offset anyway, and splice() refuses appending files, so tools that
		// splice, such as uutils cat, would fall back to line-buffered writes.
		file, err := os.OpenFile(filepath.Join(directory, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return nil, err
		}
		childEnds = append(childEnds, file)
		if index == 0 {
			command.Stdout = file
		} else {
			command.Stderr = file
		}
	}
	var stdin *os.File
	if detached.Stdin {
		fifo := filepath.Join(directory, "stdin")
		if err := unix.Mkfifo(fifo, 0o600); err != nil {
			return nil, err
		}
		// As a writer too, the process never sees EOF, whoever else closes the FIFO.
		reader, err := os.OpenFile(fifo, os.O_RDWR, 0)
		if err != nil {
			return nil, err
		}
		childEnds = append(childEnds, reader)
		command.Stdin = reader
		stdin, err = os.OpenFile(fifo, os.O_WRONLY|syscall.O_NONBLOCK, 0)
		if err != nil {
			return nil, err
		}
	}
	if err := command.Start(); err != nil {
		if stdin != nil {
			stdin.Close()
		}
		return nil, startError(err)
	}
	process := &detachedProcess{name: detached.Name, directory: directory, pid: command.Process.Pid, stdin: stdin, exited: make(chan struct{})}
	// Recorded before anything reaps the process, which keeps its /proc entry until then.
	if err := record(directory, process.pid); err != nil {
		// Without its record a restarted helper couldn't find it, so it mustn't run.
		syscall.Kill(-process.pid, syscall.SIGKILL)
		command.Wait()
		if stdin != nil {
			stdin.Close()
		}
		return nil, err
	}
	go func() {
		// Exit codes are reported through ProcessState.
		command.Wait()
		process.status = exitedStatus(command.ProcessState)
		close(process.exited)
	}()
	return process, nil
}

// Writes a file whole or not at all, so a helper stopping mid-write leaves nothing torn behind.
func writeAtomically(path, content string) error {
	if err := os.WriteFile(path+".new", []byte(content), 0o600); err != nil {
		return err
	}
	return os.Rename(path+".new", path)
}

func record(directory string, pid int) error {
	started, err := startTime(pid)
	if err != nil {
		return err
	}
	return writeAtomically(filepath.Join(directory, "process"), fmt.Sprintf("%d %s\n", pid, started))
}

func (p *detachedProcess) detach(cause error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.attachment != nil {
		p.attachment.end(cause)
		p.attachment = nil
	}
}

func (p *detachedProcess) isExited() bool {
	select {
	case <-p.exited:
		return true
	default:
		return false
	}
}

func outputSize(directory string, index int) (int64, error) {
	info, err := os.Stat(filepath.Join(directory, outputFiles[index]))
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// Offsets must lie between what was acknowledged and what was written. Call with p.mu held.
func (p *detachedProcess) checkOffsets(offsets [2]int64) error {
	for index, offset := range offsets {
		size, err := outputSize(p.directory, index)
		if err != nil {
			return err
		}
		if offset < p.acknowledged[index] {
			return status.Errorf(codes.OutOfRange, "%s before offset %d was acknowledged and freed", outputFiles[index], p.acknowledged[index])
		}
		if offset > size {
			return status.Errorf(codes.OutOfRange, "%s offset %d is beyond its %d bytes", outputFiles[index], offset, size)
		}
	}
	return nil
}

func (p *detachedProcess) acknowledge(offsets [2]int64) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.acknowledgeLocked(offsets)
}

// Call with p.mu held.
func (p *detachedProcess) acknowledgeLocked(offsets [2]int64) error {
	if offsets == p.acknowledged {
		return nil
	}
	for index, offset := range offsets {
		if offset < p.acknowledged[index] {
			return status.Errorf(codes.InvalidArgument, "%s was already acknowledged up to offset %d", outputFiles[index], p.acknowledged[index])
		}
	}
	if err := p.checkOffsets(offsets); err != nil {
		return err
	}
	if err := writeAtomically(filepath.Join(p.directory, "acknowledged"), fmt.Sprintf("%d %d\n", offsets[0], offsets[1])); err != nil {
		return err
	}
	p.acknowledged = offsets
	for index, offset := range offsets {
		length := offset - offset%punchAlignment
		if length == 0 {
			continue
		}
		file, err := os.OpenFile(filepath.Join(p.directory, outputFiles[index]), os.O_WRONLY, 0)
		if err != nil {
			return err
		}
		// Offsets stay valid: the file keeps its size and reads as zeros where it was freed.
		err = unix.Fallocate(int(file.Fd()), unix.FALLOC_FL_PUNCH_HOLE|unix.FALLOC_FL_KEEP_SIZE, 0, length)
		file.Close()
		if err != nil {
			return fmt.Errorf("free acknowledged %s: %w", outputFiles[index], err)
		}
	}
	return nil
}

func (p *detachedProcess) write(current *attachment, data []byte) error {
	p.writing.Lock()
	defer p.writing.Unlock()
	p.mu.Lock()
	displaced := p.attachment != current
	p.mu.Unlock()
	if displaced {
		return status.Error(codes.Aborted, "another call attached to this process")
	}
	if p.stdin == nil {
		return status.Error(codes.FailedPrecondition, "the process has no stdin")
	}
	if _, err := p.stdin.Write(data); err != nil && !errors.Is(err, syscall.EPIPE) {
		return err
	}
	return nil
}

func (p *detachedProcess) signal(requested pb.Signal) error {
	signal, err := validSignal(requested)
	if err != nil {
		return err
	}
	if err := syscall.Kill(-p.pid, signal); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}

// Wakes the attached call whenever the process writes output.
func watchOutput(directory string) (<-chan struct{}, func(), error) {
	descriptor, err := unix.InotifyInit1(unix.IN_CLOEXEC | unix.IN_NONBLOCK)
	if err != nil {
		return nil, nil, err
	}
	if _, err := unix.InotifyAddWatch(descriptor, directory, unix.IN_MODIFY); err != nil {
		unix.Close(descriptor)
		return nil, nil, err
	}
	// Non-blocking, so Go's poller reads it and Close interrupts the read.
	events := os.NewFile(uintptr(descriptor), "inotify")
	changes := make(chan struct{}, 1)
	go func() {
		buffer := make([]byte, 4096)
		for {
			if _, err := events.Read(buffer); err != nil {
				return
			}
			select {
			case changes <- struct{}{}:
			default:
			}
		}
	}()
	return changes, func() { events.Close() }, nil
}

// Streams p's output from offsets to one call until the process exits or the
// call ends. `receive` applies the call's requests until it fails, which ends the call.
func (r *registry) stream(ctx context.Context, p *detachedProcess, offsets [2]int64, send func(*pb.ExecResponse) error, receive func(*attachment) error) error {
	ctx, end := context.WithCancelCause(ctx)
	defer end(nil)
	current := &attachment{end: end}
	p.mu.Lock()
	if err := p.checkOffsets(offsets); err != nil {
		p.mu.Unlock()
		return err
	}
	// Continuing from offsets acknowledges what came before them.
	if err := p.acknowledgeLocked(offsets); err != nil {
		p.mu.Unlock()
		return err
	}
	if p.attachment != nil {
		p.attachment.end(status.Error(codes.Aborted, "another call attached to this process"))
	}
	p.attachment = current
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		if p.attachment == current {
			p.attachment = nil
		}
		p.mu.Unlock()
	}()

	// Watch before the first read, so no write goes unnoticed.
	changes, stopWatching, err := watchOutput(p.directory)
	if err != nil {
		return err
	}
	defer stopWatching()
	var readers [2]*os.File
	for index, name := range outputFiles {
		readers[index], err = os.Open(filepath.Join(p.directory, name))
		if err != nil {
			return err
		}
		defer readers[index].Close()
		if _, err := readers[index].Seek(offsets[index], io.SeekStart); err != nil {
			return err
		}
	}
	go func() {
		if err := receive(current); err != nil {
			end(err)
		}
	}()

	wrap := [2]func([]byte) *pb.ExecResponse{
		func(data []byte) *pb.ExecResponse {
			return &pb.ExecResponse{Response: &pb.ExecResponse_Stdout{Stdout: data}}
		},
		func(data []byte) *pb.ExecResponse {
			return &pb.ExecResponse{Response: &pb.ExecResponse_Stderr{Stderr: data}}
		},
	}
	buffer := make([]byte, 32*1024)
	drain := func() error {
		for index, reader := range readers {
			for {
				n, err := reader.Read(buffer)
				if n > 0 {
					if err := send(wrap[index](append([]byte(nil), buffer[:n]...))); err != nil {
						return err
					}
				}
				if err == io.EOF {
					break
				}
				if err != nil {
					return err
				}
			}
		}
		return nil
	}
	for {
		// Checked before draining, so everything written before the exit is sent.
		exited := p.isExited()
		if err := drain(); err != nil {
			return err
		}
		if exited {
			if err := send(&pb.ExecResponse{Response: &pb.ExecResponse_Exited{Exited: p.status}}); err != nil {
				return err
			}
			r.remove(p)
			return nil
		}
		select {
		case <-changes:
		case <-p.exited:
		case <-ctx.Done():
			cause := context.Cause(ctx)
			if _, ok := status.FromError(cause); ok {
				return cause
			}
			return status.FromContextError(cause).Err()
		}
	}
}

// Forgets a process whose exit was reported.
func (r *registry) remove(p *detachedProcess) {
	r.mu.Lock()
	if r.processes[p.name] == p {
		delete(r.processes, p.name)
	}
	r.mu.Unlock()
	if p.stdin != nil {
		p.stdin.Close()
	}
	if err := os.RemoveAll(p.directory); err != nil {
		log.Printf("detached process %s: remove its state: %v", p.name, err)
	}
}

func (r *registry) find(name string) (*detachedProcess, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	process := r.processes[name]
	if process == nil {
		return nil, status.Errorf(codes.NotFound, "no process named %q", name)
	}
	return process, nil
}

func offsetsOf(stdout, stderr uint64) [2]int64 {
	return [2]int64{int64(stdout), int64(stderr)}
}

func (s *helper) execDetached(stream pb.WorkspaceHelper_ExecServer, start *pb.ExecStart, account identity) error {
	process, err := s.detached.start(start, account, s.switchUser)
	if err != nil {
		return err
	}
	return s.detached.stream(stream.Context(), process, [2]int64{}, stream.Send, func(current *attachment) error {
		for {
			request, err := stream.Recv()
			if err == io.EOF {
				// Unlike a plain Exec, stdin stays open.
				return nil
			}
			if err != nil {
				// The call ended; stream notices through the context.
				return nil
			}
			switch request := request.Request.(type) {
			case *pb.ExecRequest_Stdin:
				err = process.write(current, request.Stdin)
			case *pb.ExecRequest_Signal:
				err = process.signal(request.Signal)
			case *pb.ExecRequest_Acknowledge:
				err = process.acknowledge(offsetsOf(request.Acknowledge.StdoutOffset, request.Acknowledge.StderrOffset))
			case *pb.ExecRequest_CloseStdin:
				err = status.Error(codes.FailedPrecondition, "a detached process's stdin stays open; send a signal to stop it")
			case *pb.ExecRequest_Resize:
				err = status.Error(codes.FailedPrecondition, "resize needs a terminal")
			case *pb.ExecRequest_Start:
				err = status.Error(codes.InvalidArgument, "start was already sent")
			default:
				err = status.Errorf(codes.InvalidArgument, "unknown request %T", request)
			}
			if err != nil {
				return err
			}
		}
	})
}

func (s *helper) Attach(stream pb.WorkspaceHelper_AttachServer) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	attach := first.GetAttach()
	if attach == nil {
		return status.Error(codes.InvalidArgument, "the first request must be attach")
	}
	process, err := s.detached.find(attach.Name)
	if err != nil {
		return err
	}
	return s.detached.stream(stream.Context(), process, offsetsOf(attach.StdoutOffset, attach.StderrOffset), stream.Send, func(current *attachment) error {
		for {
			request, err := stream.Recv()
			if err != nil {
				// A closed request stream leaves the process running; a failed call is noticed through the context.
				return nil
			}
			switch request := request.Request.(type) {
			case *pb.AttachRequest_Stdin:
				err = process.write(current, request.Stdin)
			case *pb.AttachRequest_Signal:
				err = process.signal(request.Signal)
			case *pb.AttachRequest_Acknowledge:
				err = process.acknowledge(offsetsOf(request.Acknowledge.StdoutOffset, request.Acknowledge.StderrOffset))
			case *pb.AttachRequest_Attach:
				err = status.Error(codes.InvalidArgument, "attach was already sent")
			default:
				err = status.Errorf(codes.InvalidArgument, "unknown request %T", request)
			}
			if err != nil {
				return err
			}
		}
	})
}

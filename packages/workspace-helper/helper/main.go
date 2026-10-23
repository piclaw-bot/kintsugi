// Runs inside a workspace and serves the app's WorkspaceHelper calls.
package main

import (
	"flag"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"google.golang.org/grpc"

	pb "kintsugi/workspace-helper/workspacehelperv1"
)

func listen(path string) (net.Listener, error) {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := restrict(path); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}

// The socket runs anything as root, so only the directory's owner, the app,
// may connect.
func restrict(path string) error {
	var directory syscall.Stat_t
	if err := syscall.Stat(filepath.Dir(path), &directory); err != nil {
		return err
	}
	if err := os.Chown(path, int(directory.Uid), int(directory.Gid)); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func main() {
	socket := flag.String("listen", "/run/kintsugi-helper/helper.sock", "Unix socket to serve on")
	cert := flag.String("tls-cert-file", "/etc/kintsugi-helper/cert.pem", "Workspace helper certificate")
	key := flag.String("tls-key-file", "/etc/kintsugi-helper/key.pem", "Workspace helper private key")
	insecure := flag.Bool("allow-unauthenticated", false, "Allow unauthenticated local test clients")
	// On the workspace's disk, outside /tmp: only root may write it, and nothing ages it out.
	state := flag.String("state", "/var/lib/kintsugi-helper", "Directory for detached processes' output and input")
	flag.Parse()
	if os.Geteuid() != 0 {
		log.Fatal("the workspace helper must run as root")
	}
	detached, err := openRegistry(filepath.Join(*state, "processes"))
	if err != nil {
		log.Fatalf("open %s: %v", *state, err)
	}
	listener, err := listen(*socket)
	if err != nil {
		log.Fatalf("listen on %s: %v", *socket, err)
	}
	var options []grpc.ServerOption
	if !*insecure {
		creds, err := helperCredentials(*cert, *key)
		if err != nil {
			log.Fatalf("helper TLS credentials: %v", err)
		}
		options = append(options, grpc.Creds(creds))
	}
	server := grpc.NewServer(options...)
	pb.RegisterWorkspaceHelperServer(server, &helper{
		users:      map[pb.User]string{pb.User_USER_AGENT: "agent", pb.User_USER_ROOT: "root"},
		switchUser: true,
		detached:   detached,
	})
	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
		<-stop
		// Running calls end, and with them their processes, except detached ones.
		server.Stop()
	}()
	log.Printf("workspace helper listening on %s", *socket)
	if err := server.Serve(listener); err != nil {
		log.Fatal(err)
	}
}

import { shellQuote } from "@kintsugi/core";
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function workspaceId() {
  const file = '/work/.git/ios-serve-sim-id';
  if (!existsSync(file)) writeFileSync(file, crypto.randomUUID(), { flag: 'wx' });
  const id = readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error(`Invalid workspace identity in ${file}`);
  return id;
}

export const workspaceRoot = (id: string) => `$HOME/.local/share/kintsugi/ios-serve-sim/workspaces/${id}`;
export const deviceName = (id: string) => `ios-serve-sim-${id}`;

// Runs on the Mac, independently of the SSH connection. EOF handles normal
// deletion; a deadline handles a lost connection whose stdin never closes.
// The lock prevents a second viewer from taking over or deleting a live lease.
export const guardian = String.raw`
use strict;
use warnings;
use POSIX qw(setsid WNOHANG);
use File::Path qw(make_path remove_tree);
use Time::HiRes qw(time sleep);
my ($root, $script, $cleanup, $timeout) = @ARGV;
make_path($root =~ s{/[^/]+$}{}r);
mkdir "$root.lock" or die "Workspace lease already exists: $root.lock: $!\n";
my $interrupted = 0;
$SIG{TERM} = $SIG{INT} = $SIG{HUP} = sub { $interrupted = 1; };
pipe(my $started_read, my $started_write) or die "pipe: $!";
my $child = fork();
defined $child or die "fork: $!";
if ($child == 0) {
  close $started_read;
  $SIG{TERM} = $SIG{INT} = $SIG{HUP} = 'DEFAULT';
  setsid() >= 0 or die "setsid: $!";
  syswrite($started_write, '1');
  close $started_write;
  open STDIN, '<', '/dev/null' or die "stdin: $!";
  exec '/bin/bash', '-c', $script;
  die "exec: $!";
}
close $started_write;
# Do not kill the process group before the child has established it.
sysread($started_read, my $started, 1);
close $started_read;
my $deadline = time() + $timeout;
my $code = 0;
while (!$interrupted) {
  my $done = waitpid($child, WNOHANG);
  if ($done == $child) { $code = ($? & 127) ? 128 + ($? & 127) : $? >> 8; last; }
  if (time() >= $deadline) { print STDERR "Workspace heartbeat expired; cleaning up\n"; last; }
  my $ready = '';
  vec($ready, fileno(STDIN), 1) = 1;
  if (select($ready, undef, undef, 1) > 0) {
    my $bytes = sysread(STDIN, my $message, 4096);
    last unless $bytes;
    $deadline = time() + $timeout;
  }
}
kill 'TERM', -$child;
sleep 1;
kill 'KILL', -$child;
waitpid($child, WNOHANG);
my $result = system('/bin/bash', '-c', $cleanup);
if ($result != 0) { die "Remote cleanup failed ($result); retained $root for investigation\n"; }
remove_tree($root);
die "Workspace files remain at $root\n" if -e $root;
rmdir "$root.lock" or die "remove lock: $!";
print STDERR "Workspace simulator and files cleaned up\n";
exit $code;
`;

// Detached upstream helpers may leave the viewer's process group. Their
// inherited, workspace-specific TMPDIR marks them as part of this lease.
const cleanupRuby = String.raw`
require 'json'
root, name = ARGV
raw = IO.popen(['xcrun', 'simctl', 'list', 'devices', '-j'], &:read)
raise 'simctl list failed' unless $?.success?
devices = JSON.parse(raw).fetch('devices').values.flatten.select { |d| d.fetch('name') == name }
devices.each do |d|
  udid = d.fetch('udid')
  if File.exist?(File.join(root, 'tmp', 'serve-sim', 'simcam', "#{udid}.pid"))
    ok = system({'TMPDIR' => "#{root}/tmp/"}, File.join(root, 'node', 'bin', 'node'),
      File.join(root, 'npm', 'node_modules', '.bin', 'serve-sim'), 'camera', '--stop-webcam', '-d', udid)
    raise 'serve-sim camera cleanup failed' unless ok
  end
end
marker = "TMPDIR=#{root}/tmp/"
processes = IO.popen(['ps', 'eww', '-axo', 'pid=,command='], &:read).lines.map do |line|
  pid, command = line.strip.split(/\s+/, 2)
  pid.to_i if command && command.split.include?(marker)
end.compact
processes.each { |pid| begin; Process.kill('TERM', pid); rescue Errno::ESRCH; end }
sleep 1 unless processes.empty?
processes.each { |pid| begin; Process.kill('KILL', pid); rescue Errno::ESRCH; end }
failed = false
devices.each do |d|
  if d.fetch('state') == 'Booted'
    failed = true unless system('xcrun', 'simctl', 'shutdown', d.fetch('udid'))
  end
  failed = true unless system('xcrun', 'simctl', 'delete', d.fetch('udid'))
end
exit(failed ? 1 : 0)
`;

export function guardedCommand(id: string, script: string) {
  const root = workspaceRoot(id);
  const cleanup = `/usr/bin/ruby -e ${shellQuote(cleanupRuby)} "${root}" ${shellQuote(deviceName(id))}`;
  return `/usr/bin/perl -e ${shellQuote(guardian)} "${root}" ${shellQuote(script)} ${shellQuote(cleanup)} 45`;
}

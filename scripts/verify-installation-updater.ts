import { join, dirname } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { app: { type: 'string' }, system: { type: 'string' }, workspace: { type: 'string' }, out: { type: 'string', default: '/tmp/kintsugi-updater-native-receipts.json' } } });
if (!values.app || !values.system || !values.workspace) throw Error('Usage: bun scripts/verify-installation-updater.ts --app LOCAL_APP --system LOCAL_SYSTEM --workspace LOCAL_WORKSPACE [--out FILE]');
const temporary = await mkdtemp(join(tmpdir(), 'kintsugi-updater-acceptance-'));
const appBase = values.app, systemBase = values.system;

const repo = dirname(import.meta.dir), name = 'kintsugi-host-updater-acceptance', service = name + '-service', control = name + '-control', port = 3160;
const oldApp = 'kintsugi:updater-acceptance-old', oldSystem = 'kintsugi-system:updater-acceptance-old', newApp = 'kintsugi:host-updater-native', newSystem = 'kintsugi-system:host-updater-native', workspace = values.workspace;
async function run(args: string[], input?: string) { const p = Bun.spawn(args, { cwd: repo, stdin: input ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' }); if (input) { p.stdin!.write(input); p.stdin!.end(); } const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]); if (code) throw Error(args.slice(0, 3).join(' ') + ': ' + err.slice(-2000)); return out.trim(); }
const docker = (...args: string[]) => run(['docker', ...args]);
async function wait(action: () => Promise<boolean>, label: string) { for (let i = 0; i < 180; i++) { if (await action()) return; await Bun.sleep(1000); } throw Error('Timed out: ' + label); }
for (const n of [name, service]) if ((await docker('ps', '-a', '--format', '{{.Names}}')).split('\n').includes(n)) throw Error('Owned fixture name already exists: ' + n);
for (const n of [name, control]) if ((await docker('volume', 'ls', '--format', '{{.Name}}')).split('\n').includes(n)) throw Error('Owned fixture volume already exists: ' + n);
await run(['bun', 'images/system/build.ts']);
const appFile = join(temporary, 'app.Dockerfile'), systemFile = join(temporary, 'system.Dockerfile');
for (const reference of [appBase, systemBase, workspace]) await docker('image', 'inspect', '--format', '{{.Id}}', reference);
await Bun.write(appFile, `FROM ${appBase}
COPY packages/update/src/ /app/packages/update/src/
COPY packages/shared/src/ /app/packages/shared/src/
COPY packages/shared/package.json /app/packages/shared/package.json
COPY apps/web/src/server/admin/routes.ts /app/apps/web/src/server/admin/routes.ts
RUN bun run --cwd apps/web build:client
LABEL org.opencontainers.image.revision="acceptance-old"
`);
await Bun.write(systemFile, `FROM ${systemBase}
LABEL kintsugi.host-updater="1" org.opencontainers.image.revision="acceptance-old"
COPY images/system/.build/supervisor.js images/system/.build/client.js images/system/.build/design-system.css images/system/.build/host-updater.js images/system/.build/install.sh /opt/kintsugi-system/
`);
console.log('Building current native fixture images');
await docker('build', '-f', appFile, '-t', oldApp, '.'); await docker('build', '-f', systemFile, '-t', oldSystem, '.');
await Bun.write(appFile, `FROM ${oldApp}
LABEL org.opencontainers.image.revision="acceptance-new"
`);
await Bun.write(systemFile, `FROM ${oldSystem}
LABEL org.opencontainers.image.revision="acceptance-new"
`);
await docker('build', '-f', appFile, '-t', newApp, '.'); await docker('build', '-f', systemFile, '-t', newSystem, '.');
const newAppId = await docker('image', 'inspect', '--format', '{{.Id}}', newApp), newSystemId = await docker('image', 'inspect', '--format', '{{.Id}}', newSystem), oldAppId = await docker('image', 'inspect', '--format', '{{.Id}}', oldApp), oldSystemId = await docker('image', 'inspect', '--format', '{{.Id}}', oldSystem);
const appRef = 'ghcr.io/example/app@' + newAppId, systemRef = 'ghcr.io/example/system@' + newSystemId;
const daemonRoot = await docker('info', '--format', '{{.DockerRootDir}}');
let created = false;
const bootstrap = `const fs=await import('node:fs/promises');const p='/etc/docker/daemon.json',d=await Bun.file(p).json();d['storage-driver']='overlayfs';await Bun.write(p,JSON.stringify(d));const c='/etc/containerd/config.toml';await Bun.write(c,(await Bun.file(c).text()).replace('default = ["erofs", "walking"]','default = ["walking"]'));await fs.mkdir('/data/supervisor',{recursive:true});await fs.mkdir('/data/app',{recursive:true});await Bun.write('/data/supervisor/storage.json',JSON.stringify({driver:'overlayfs'}));await Bun.write('/data/supervisor/state.json',JSON.stringify({accessMode:'proxy',pendingImage:${JSON.stringify(oldAppId)},proxy:{origin:'http://localhost:${port}',previewPorts:{start:41000,end:41009}}}));await Bun.write('/data/app/update.json',JSON.stringify({releaseMode:'custom',releaseSelection:'latest',releaseSource:{appRepository:'ghcr.io/example/app',systemRepository:'ghcr.io/example/system',appVersion:'latest',systemVersion:'latest'}}));await Bun.write('/data/app/updater-fixture.txt','retained-data');`;
const receipts = { fixture: 'native cached-image installation update; registry resolution/pulls are mapped to preloaded local image IDs', defaultSystemdInstallation: 'not exercised in this non-systemd workspace', prepared: false, newPairHealthy: false, appReconnect: false, retainedPairRestored: false, savedDataStorageSelectionRetained: false, proxyPublicationRetained: false, noPhysicalDockerInSystem: false, readOnlyPrivateSocket: false };
try {
  await docker('volume', 'create', name); await docker('volume', 'create', control); created = true;
  await docker('run', '-d', '--name', name, '--privileged', '--cgroupns=host', '--tmpfs', '/run', '--mount', `source=${name},target=/data`, '--entrypoint', '/bin/sh', oldSystem, '-ec', `bun -e ${JSON.stringify(bootstrap)}; chown -R 1000:1000 /data/app; exec /usr/local/bin/kintsugi-dockerd dockerd`);
  await wait(async () => { try { await docker('exec', name, 'docker', 'info'); return true; } catch { return false; } }, 'fixture Docker');
  const save = Bun.spawn(['docker', 'save', oldApp, newApp, workspace], { stdout: 'pipe', stderr: 'pipe' });
  const load = Bun.spawn(['docker', 'exec', '-i', name, 'docker', 'load'], { stdin: save.stdout, stdout: 'pipe', stderr: 'pipe' });
  const [s, l, loadOut, saveErr, loadErr] = await Promise.all([save.exited, load.exited, new Response(load.stdout).text(), new Response(save.stderr).text(), new Response(load.stderr).text()]); if (s || l) throw Error(saveErr + loadErr); console.log(loadOut.trim());
  await docker('stop', '--timeout', '60', name); await docker('rm', name);
  let installer = await Bun.file(join(repo, 'scripts/install.sh')).text(); installer = installer.replace('system_name=kintsugi-system', `system_name=${name}`).replace('no_updater=0', 'no_updater=1').replace('updater_mount=()', `updater_mount=(--mount "type=volume,source=${control},target=/run/kintsugi-updater,readonly")`);
  await Bun.write(join(temporary, 'installer.sh'), installer);
  const source = `import {InstallationUpdater,updaterHandler} from '/opt/kintsugi-system/host-updater.js';import {mkdir,chmod} from 'node:fs/promises';
  const app=${JSON.stringify(appRef)},system=${JSON.stringify(systemRef)},appId=${JSON.stringify(newAppId)},systemId=${JSON.stringify(newSystemId)};
  async function execute(args){const p=Bun.spawn(args,{stdin:'ignore',stdout:'pipe',stderr:'pipe'});const [code,stdout,stderr]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);if(code)console.error('Fixture subprocess failed',args[0],stderr.slice(-1000));return {code,stdout};}
  const updater=new InstallationUpdater({directory:'/run/kintsugi-updater/state',installer:'/tmp/installer.sh',systemName:${JSON.stringify(name)},resolve:async ref=>({reference:ref.includes('/system:')?system:app,revision:'acceptance-new',layers:[],dependencies:[]}),command:async args=>{
    if(args.includes('pull')&&args.includes(system))return execute(['docker','image','inspect',systemId]);
    if(args.some(arg=>arg.includes('/release/prepare')))return execute(['docker','exec',${JSON.stringify(name)},'docker','image','inspect',appId,${JSON.stringify(workspace)}]);
    return execute(args.map(arg=>arg===app?appId:arg===system?systemId:arg));
  }});await updater.initialize();await mkdir('/run/kintsugi-updater',{recursive:true,mode:0o700});await chmod('/run/kintsugi-updater',0o700);const server=Bun.serve({unix:'/run/kintsugi-updater/control.sock',maxRequestBodySize:4096,fetch:updaterHandler(updater)});await chmod('/run/kintsugi-updater/control.sock',0o600);process.on('SIGTERM',async()=>{server.stop(true);await updater.wait();process.exit(0);});`;
  await docker('run', '-d', '--name', service, '--mount', `type=bind,source=${daemonRoot},target=${daemonRoot},readonly`, '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock', '--mount', `source=${control},target=/run/kintsugi-updater`, '--entrypoint', 'bun', newSystem, '-e', source);
  await docker('cp', join(temporary, 'installer.sh'), service + ':/tmp/installer.sh');
  await docker('run', '-d', '--name', name, '--label', 'kintsugi.storage-driver=overlayfs', '--privileged', '--cgroupns=host', '--tmpfs', '/run', '--publish', `127.0.0.1:${port}:3081`, '--mount', `source=${name},target=/data`, '--mount', `source=${control},target=/run/kintsugi-updater,readonly`, oldSystem, '--app-image', oldApp, '--access-mode', 'proxy');
  async function rootStatus() { return JSON.parse(await docker('exec', service, 'bun', '-e', `console.log(await(await fetch('http://updater/status',{unix:'/run/kintsugi-updater/control.sock'})).text());`)); }
  async function http(path: string, method = 'GET') { const r = await fetch(`http://localhost:${port}${path}`, { method, headers: { origin: `http://localhost:${port}`, accept: 'application/json', 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined }); if (!r.ok) throw Error(path + ': ' + r.status + ' ' + (await r.text()).slice(0, 300)); return r.json(); }
  await wait(async () => { try { return (await http('/update/status')).updateScope === 'installation'; } catch { return false; } }, 'whole-installation app');
  await http('/update/check-now', 'POST'); await http('/update/start', 'POST');
  await wait(async () => { const s = await rootStatus(); if (s.phase === 'failed') throw Error(s.message); return s.phase === 'ready'; }, 'prepared images');
  receipts.prepared = true; console.log('Both components prepared through existing app controls');
  await wait(async () => { return (await http('/update/status')).state === 'ready_to_restart'; }, 'app ready control');
  await http('/update/restart', 'POST');
  await wait(async () => { const s = await rootStatus(); if (s.phase === 'failed' || s.phase === 'rolled-back') throw Error(s.message); return s.phase === 'succeeded'; }, 'whole installation replacement');
  const actualSystem = await docker('inspect', '--format', '{{.Image}}', name), actualApp = await docker('exec', name, 'docker', 'inspect', '--format', '{{.Image}}', 'kintsugi');
  if (actualSystem !== newSystemId || actualApp !== newAppId) throw Error('New immutable pair was not running'); receipts.newPairHealthy = true;
  await wait(async () => { try { const s = await http('/update/status'); return s.updateScope === 'installation' && s.state === 'idle'; } catch { return false; } }, 'app updater reconnect'); receipts.appReconnect = true;
  await http('/update/rollback', 'POST'); await wait(async () => { const s = await rootStatus(); if (s.phase === 'failed') throw Error(s.message); return s.phase === 'rolled-back'; }, 'retained pair rollback');
  if ((await docker('inspect', '--format', '{{.Image}}', name)) !== oldSystemId || (await docker('exec', name, 'docker', 'inspect', '--format', '{{.Image}}', 'kintsugi')) !== oldAppId) throw Error('Previous pair was not restored'); receipts.retainedPairRestored = true;
  const data = await docker('exec', name, 'bun', '-e', `console.log(await Bun.file('/data/app/updater-fixture.txt').text());console.log(await Bun.file('/data/supervisor/storage.json').text());console.log(await Bun.file('/data/app/update.json').text());`);
  if (!data.includes('retained-data') || !data.includes('overlayfs') || !data.includes('ghcr.io/example/app')) throw Error('Saved installation data changed'); receipts.savedDataStorageSelectionRetained = true;
  const bindings = JSON.parse(await docker('inspect', '--format', '{{json .HostConfig.PortBindings}}', name)); if (!bindings['3081/tcp']?.some((binding: { HostIp: string; HostPort: string }) => binding.HostIp === '127.0.0.1' && binding.HostPort === String(port))) throw Error('Proxy publication was not retained'); receipts.proxyPublicationRetained = true;
  const mounts = JSON.parse(await docker('inspect', '--format', '{{json .Mounts}}', name)); if (mounts.some((m: { Destination: string }) => m.Destination === '/var/run/docker.sock')) throw Error('Physical Docker socket leaked into System'); receipts.noPhysicalDockerInSystem = true;
  if (!mounts.some((mount: { Destination: string; RW: boolean }) => mount.Destination === '/run/kintsugi-updater' && !mount.RW)) throw Error('Private socket mount was not read-only'); receipts.readOnlyPrivateSocket = true;
  console.log(JSON.stringify(receipts, null, 2)); await Bun.write(values.out!, JSON.stringify(receipts, null, 2) + '\n');
} catch (error) {  
console.error(error); for (const n of [name, service]) { try { console.error((await docker('logs', '--tail', '35', n))); } catch { } } throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
  if (created) { for (const n of [name, service]) { try { await docker('stop', '--timeout', '60', n); await docker('rm', n); } catch { } } for (const n of [name, control]) { try { await docker('volume', 'rm', n); } catch { } } }
}

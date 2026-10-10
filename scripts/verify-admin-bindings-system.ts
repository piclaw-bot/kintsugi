// Real, disposable System/Docker integration. Never targets an existing installation.
// Requires locally built app + System images; creates and cleans its own containers/volume.
import { strict as assert } from "node:assert";
import { mkdtemp, rm, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parseArgs } from "node:util";
import { caddyRecipe } from "./deployment.ts";
import { createAdminStore, adminScopes } from "../apps/web/src/server/admin/store.ts";

const { values } = parseArgs({ options: { app: { type: "string", default: "kintsugi-admin:local" }, system: { type: "string", default: "kintsugi-system:admin-local" }, workspace: { type: "string" }, "release-updates": { type: "boolean", default: false }, "installer-system": { type: "string" }, "storage-driver": { type: "string", default: "erofs" }, "proxy-access": { type: "boolean", default: false } } });
const storageDriver = values["storage-driver"]!;
if (storageDriver !== "erofs" && storageDriver !== "overlayfs") throw new Error("Unsupported storage driver");
const name = `kintsugi-admin-integration-${crypto.randomUUID().slice(0, 8)}`;
const volume = name;
const caddy = `${name}-caddy`;
let proxyCert = "";
let proxySecret = "";
const fixtureApp = `${name}:app`;
const hostPort = 35000 + Math.floor(Math.random() * 4000);
const proxyOrigin = `https://127.0.0.1:${hostPort + 3}`;
const proxyApiOrigin = `https://127.0.0.1:${hostPort + 4}`;
const proxyConfig = { origin: proxyOrigin, previewPorts: { start: 41000, end: 41009 }, adminPort: 3445 };
const mode = values["proxy-access"] ? "proxy" : "localhost";
const directory = await mkdtemp(join(tmpdir(), "kintsugi-admin-system-"));
async function run(args: string[], input?: string) {
  const child = Bun.spawn(args, { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw new Error(`Integration command ${args[0]} ${args[1]} failed (${exit})${args.includes("-e") ? ": details suppressed for credential safety" : `: ${stderr.slice(-1600)}`}`);
  return stdout.trim();
}
const exec = (...args: string[]) => run(["docker", "exec", name, ...args]);
async function proxyRequest(path: string, method = "GET", body = "", api = false, origin = proxyOrigin, destination = api ? proxyApiOrigin : proxyOrigin, authenticated = true) {
  const code = `const headers={"content-type":"application/json",accept:"application/json",origin:${JSON.stringify(origin)}};${api && authenticated ? `headers.authorization=${JSON.stringify("Bearer "+proxySecret)};` : ""}const r=await fetch(${JSON.stringify(destination+path)},{method:${JSON.stringify(method)},headers,${method==="GET"?"":`body:${JSON.stringify(body)},`}tls:{ca:${JSON.stringify(proxyCert)}}});console.log(JSON.stringify({status:r.status,body:await r.text(),url:r.url}));`;
  return JSON.parse(await run(["docker","run","--rm","--network","host","--entrypoint","bun",values.app!,"-e",code]));
}
async function proxyStream(origin: string, path: string, websocket = false) {
  const code = websocket ? `const ws=new WebSocket(${JSON.stringify(origin.replace("https:","wss:")+path)},{headers:{origin:${JSON.stringify(origin)}},tls:{ca:${JSON.stringify(proxyCert)}}});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(Error("WS timeout"));},10000);ws.onopen=()=>ws.send("echo");ws.onmessage=event=>{clearTimeout(timer);console.log(String(event.data));ws.close();resolve();};ws.onerror=()=>{clearTimeout(timer);reject(Error("WS failed"));};});` : `const r=await fetch(${JSON.stringify(origin+path)},{headers:{origin:${JSON.stringify(origin)}},tls:{ca:${JSON.stringify(proxyCert)}},signal:AbortSignal.timeout(10000)});if(r.status!==200 || !r.headers.get("content-type")?.startsWith("text/event-stream"))throw Error("SSE failed");const reader=r.body.getReader();const chunk=await reader.read();console.log(new TextDecoder().decode(chunk.value));await reader.cancel();`;
  return run(["docker","run","--rm","--network","host","--entrypoint","bun",values.app!,"-e",code]);
}
async function until(check: () => Promise<boolean>, label: string, milliseconds = 180_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (await check()) return; await Bun.sleep(500); }
  throw new Error(`Timed out: ${label}`);
}
try {
  const preloads: unknown = JSON.parse(await run(["docker", "image", "inspect", "--format", '{{index .Config.Labels "eagerly-preload"}}', values.app!]));
  if (!Value.Check(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), preloads)) throw new Error("App image must declare its baked workspace image, or use an image built by this repository");
  const workspaceImage = values.workspace ?? preloads[0]!;
  await run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
  await chmod(join(directory, "key.pem"), 0o600);
  const store = createAdminStore(join(directory, "admin-bindings.json"));
  await store.setBindings([{ host: "0.0.0.0", port: 3443, tls: { cert: "/data/app/admin-tls/cert.pem", key: "/data/app/admin-tls/key.pem" } }]);
  const issued = await store.issue({ name: "integration", scopes: [...adminScopes] });
  const cert = await readFile(join(directory, "cert.pem"), "utf8");
  // Start only dockerd for preloading, as in the existing System bootstrap test.
  const bootstrap = `import {readFile,writeFile,mkdir} from "node:fs/promises";const driver=${JSON.stringify(storageDriver)};const path="/etc/docker/daemon.json";const config=JSON.parse(await readFile(path,"utf8"));config["storage-driver"]=driver;await writeFile(path,JSON.stringify(config));if(driver==="overlayfs"){const path="/etc/containerd/config.toml";await writeFile(path,(await readFile(path,"utf8")).replace('default = ["erofs", "walking"]','default = ["walking"]'));}await mkdir("/data/supervisor",{recursive:true});await writeFile("/data/supervisor/storage.json",JSON.stringify({driver}));${values["proxy-access"] ? `await writeFile("/data/supervisor/state.json",JSON.stringify({accessMode:"proxy",proxy:${JSON.stringify(proxyConfig)}}));` : ""}`;
  await run(["docker", "run", "-d", "--name", name, "--label", `kintsugi.storage-driver=${storageDriver}`, "--privileged", "--cgroupns=host", "--tmpfs", "/run", "--mount", `source=${volume},target=/data`, "--entrypoint", "/bin/sh", values.system!, "-ec", 'bun -e "$1"; exec /usr/local/bin/kintsugi-dockerd dockerd', "bootstrap", bootstrap]);
  await until(async () => (await exec("docker", "info").then(() => true, () => false)), "inner Docker daemon");
  const save = Bun.spawn(["docker", "save", values.app!, workspaceImage], { stdout: "pipe", stderr: "pipe" });
  const load = Bun.spawn(["docker", "exec", "-i", name, "docker", "load"], { stdin: save.stdout, stdout: "pipe", stderr: "pipe" });
  const outputs = await Promise.all([save.exited, load.exited, new Response(save.stderr).text(), new Response(load.stderr).text(), new Response(load.stdout).text()]);
  assert.equal(outputs[0], 0, "image save"); assert.equal(outputs[1], 0, "inner image load");
  // These are local, preloaded images, not registry releases: suppress eager pulls in this disposable fixture.
  await run(["docker", "exec", "-i", name, "docker", "build", "-t", fixtureApp, "-"], `FROM ${values.app}\nLABEL eagerly-preload="[]"\n`);
  await exec("mkdir", "-p", "/data/app/admin-tls");
  for (const file of ["key.pem", "cert.pem"]) await run(["docker", "cp", join(directory, file), `${name}:/data/app/admin-tls/${file}`]);
  await run(["docker", "cp", join(directory, "admin-bindings.json"), `${name}:/data/app/admin-bindings.json`]);
  await exec("chown", "-R", "1000:1000", "/data/app");
  await exec("chmod", "700", "/data/app/admin-tls");
  await run(["docker", "stop", "--time", "60", name]); await run(["docker", "rm", name]);
  if (values["proxy-access"]) {
    const path=join(directory,"fresh-install.sh");
    const script=(await Bun.file(new URL("./install.sh",import.meta.url)).text()).replace("system_name=kintsugi-system",`system_name=${name}`).replace("run_root mkdir -p /etc/modules-load.d","mkdir -p /etc/modules-load.d").replace("run_root tee /etc/modules-load.d","tee /etc/modules-load.d").replaceAll("/etc/modules-load.d",`${directory}/modules`);
    await Bun.write(path,script);
    const input=join(directory,"bootstrap.json"), output=join(directory,"issued.json"), result=join(directory,"result.json");
    await Bun.write(input,JSON.stringify({bindings:[{host:"0.0.0.0",port:3443,tls:{cert:"/data/app/admin-tls/cert.pem",key:"/data/app/admin-tls/key.pem"}},{host:"127.0.0.1",port:3445}],token:{name:"proxy-integration",scopes:[...adminScopes]}}));
    await run(["bash",path,"--non-interactive","--action","install","--access-mode","proxy","--storage-driver",storageDriver,"--tailscale-hostname","integration-cloud","--system-image",values.system!,"--app-image",fixtureApp,"--public-origin",proxyOrigin,"--acknowledge-lan-trust","--ui-publish",`127.0.0.1:${hostPort+5}:3081`,"--admin-proxy-publish",`127.0.0.1:${hostPort+6}:3082`,"--admin-proxy-port","3445","--admin-publish",`127.0.0.1:${hostPort}:3443`,"--admin-bootstrap",input,"--admin-token-output",output,"--result-file",result]);
    const issuedProxy=JSON.parse(await readFile(output,"utf8"));proxySecret=issuedProxy.secret;
    const receipt=JSON.parse(await readFile(result,"utf8"));
    assert.equal(receipt.storageDriver,storageDriver);assert.equal(receipt.uiUrl,proxyOrigin);assert.equal(receipt.admin.authenticatedApiReady,true);
    assert(!JSON.stringify(receipt).includes(proxySecret));
    console.log("PASS: real fresh unattended installer without PTY, transactional admin bootstrap, private token/result files and authenticated readiness");
  } else {
  await run(["docker", "run", "-d", "--name", name, "--label", `kintsugi.storage-driver=${storageDriver}`, "--privileged", "--cgroupns=host", "--tmpfs", "/run", "--publish", `127.0.0.1:${hostPort}:3443`, "--publish", `127.0.0.1:${hostPort + 1}:3080`, ...(values["proxy-access"] ? ["--publish",`127.0.0.1:${hostPort+5}:3081`,"--publish",`127.0.0.1:${hostPort+6}:3082`] : []), "--mount", `source=${volume},target=/data`, values.system!, "--app-image", fixtureApp, "--access-mode", mode]);
  }
  const localPort = Number(await run(["docker", "inspect", "--format", '{{(index (index .HostConfig.PortBindings "3080/tcp") 0).HostPort}}', name]));
  await until(async () => (await exec("bun", "-e", `const r=await fetch("http://127.0.0.1:3001/access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({mode:${JSON.stringify(mode)},localPort:${localPort}})});process.exit(r.ok?0:1);`).then(() => true, () => false)), "installer local-port registration");
  await until(async () => (await exec("bun", "-e", 'const r=await fetch("http://127.0.0.1:3001/status");process.exit((await r.json()).healthy?0:1)').then(() => true, () => false)), "real System app health");
  assert.equal(await exec("docker", "info", "--format", "{{.Driver}}"), storageDriver);
  const mappingTemplate = '{{range $port, $bindings := .HostConfig.PortBindings}}{{if ne $port "3080/tcp"}}{{range $bindings}}{{.HostIp}}:{{.HostPort}}:{{$port}}{{println}}{{end}}{{end}}{{end}}';
  const mapping = await run(["docker", "inspect", "--format", mappingTemplate, name]);
  const port = Number(await run(["docker", "inspect", "--format", '{{(index (index .HostConfig.PortBindings "3443/tcp") 0).HostPort}}', name]));
  assert(port > 0);
  async function api(path: string, method = "GET", body = "", token: string | null = issued.secret) {
    // Client is a separate container in the Docker host network namespace, not a server-side loopback request.
    const code = `const headers={"content-type":"application/json"};${token ? `headers.authorization=${JSON.stringify(`Bearer ${token}`)};` : ""}const r=await fetch(${JSON.stringify(`https://127.0.0.1:${port}${path}`)},{method:${JSON.stringify(method)},headers,${method === "GET" ? "" : `body:${JSON.stringify(body)},`}tls:{ca:${JSON.stringify(cert)}}});console.log(JSON.stringify({status:r.status,body:await r.json()}));`;
    return JSON.parse(await run(["docker", "run", "--rm", "--network", "host", "--entrypoint", "bun", values.app!, "-e", code]));
  }
  assert.equal((await api("/workspaces", "GET", "", null)).status, 401);
  assert.equal((await api("/workspaces")).status, 200);
  assert.equal((await api("/settings/access")).body.mode, mode);
  assert.equal((await api("/settings/access", "POST", JSON.stringify({mode}))).status, 200);
  const status = await api("/host/status");
  assert.equal(status.status, 200); assert.equal(status.body.healthy, true);
  assert.equal(status.body.connectionState, "Stopped");
  assert.equal((await api("/host/sample")).status, 200);
  assert.equal((await api("/host/terminals")).status, 404);
  const globalBase = "/global-workspace-settings";
  assert.equal((await api(globalBase)).status, 200);
  const variable = await api(`${globalBase}/environment`, "POST", JSON.stringify({ name: "INTEGRATION_REGION", value: "before" }));
  assert.equal(variable.status, 200);
  const variablePath = `${globalBase}/environment/${variable.body.environmentVariable.id}`;
  assert.equal((await api(variablePath, "POST", JSON.stringify({ name: "INTEGRATION_REGION", value: "after" }))).status, 200);
  const sharedSecret = await api(`${globalBase}/secrets`, "POST", JSON.stringify({ envName: "INTEGRATION_TOKEN", hostPattern: "api.example.com", secretValue: "integration-only-before" }));
  assert.equal(sharedSecret.status, 200);
  const secretPath = `${globalBase}/secrets/${sharedSecret.body.secret.id}`;
  assert.equal((await api(secretPath, "POST", JSON.stringify({ envName: "INTEGRATION_TOKEN", hostPattern: "api.example.com", secretValue: "integration-only-after" }))).status, 200);
  const globalDetail = await api(globalBase);
  assert.equal(globalDetail.body.globalWorkspaceSettings.environment[0].value, "after");
  assert(!JSON.stringify(globalDetail).includes("integration-only-after"), "Global inspection must not return secret values");
  assert.equal((await api(`${variablePath}/delete`, "POST", "{}")).status, 200);
  assert.equal((await api(`${secretPath}/delete`, "POST", "{}")).status, 200);
  if (values["proxy-access"]) {
    const recipe=caddyRecipe(proxyOrigin,`127.0.0.1:${hostPort+5}`,"41000:41009","127.0.0.1",proxyApiOrigin,`127.0.0.1:${hostPort+6}`);
    const caddyFile=join(directory,"Caddyfile");await Bun.write(caddyFile,recipe);
    await run(["docker","run","-d","--name",caddy,"--network","host","--mount",`type=bind,source=${caddyFile},target=/etc/caddy/Caddyfile,readonly`,"caddy:2"]);
    await until(async()=>run(["docker","cp",`${caddy}:/data/caddy/pki/authorities/local/root.crt`,join(directory,"proxy-ca.crt")]).then(()=>true,()=>false),"Caddy CA");
    proxyCert=await readFile(join(directory,"proxy-ca.crt"),"utf8");
    await until(async()=>(await proxyRequest("/up").then(r=>r.status===200,()=>false)),"CA-verified UI through external TLS termination");
    assert.equal((await proxyRequest("/openapi.json","GET","",true,proxyOrigin,proxyApiOrigin,false)).status,401);
    assert.equal((await proxyRequest("/openapi.json","GET","",true)).status,200);
    assert.equal((await proxyRequest("/probe-no-route","POST","{}")).status,404);
    assert.equal((await proxyRequest("/probe-no-route","POST","{}",false,"https://foreign.example")).status,403);
    assert.equal((await proxyRequest("/status")).status,404,"supervisor must not be reachable through proxy UI ingress");
    assert.equal((await api("/settings/access")).body.origin,proxyOrigin);
    console.log("PASS: transactional admin bootstrap, private token delivery, loopback HTTP upstream, CA-verified Caddy UI/API, foreign-origin rejection, private supervisor and advertised URL");
  }
  if (values["release-updates"]) {
    assert.equal((await api("/settings/release-source")).status, 200);
    assert.equal((await api("/settings/release-source", "POST", JSON.stringify({ appRepository: "https://bad.example/app", systemRepository: "ghcr.io/example/system" }))).status, 400);
    const credentials = await api("/settings/release-registry", "POST", JSON.stringify({ username: "fixture-user", token: "fixture-token" }));
    assert.deepEqual(credentials.body, { configured: true });
    assert.equal(await exec("stat", "-c", "%a", "/data/supervisor/docker-auth/config.json"), "600");
    assert.equal(await exec("stat", "-c", "%a", "/data/supervisor/docker-auth"), "700");
    assert.equal((await api("/settings/release-registry")).body.configured, true);
    assert.equal((await api("/settings/release-registry", "DELETE", "{}")).body.configured, false);
    const initial = JSON.parse(await exec("bun", "-e", 'console.log(JSON.stringify(await (await fetch("http://127.0.0.1:3001/status")).json()))')).currentImage;
    const second = `${name}:second`;
    await run(["docker", "exec", "-i", name, "docker", "build", "-t", second, "-"], `FROM ${fixtureApp}\nLABEL org.opencontainers.image.revision="fixture-second"\n`);
    const secondId = await exec("docker", "image", "inspect", "--format", "{{.Id}}", second);
    assert.notEqual(secondId, initial);
    await exec("bun", "-e", `const r=await fetch("http://127.0.0.1:3001/update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({image:${JSON.stringify(secondId)}})});if(r.status!==202)throw new Error("Update rejected");`);
    await until(async () => {
      const state = JSON.parse(await exec("bun", "-e", 'console.log(JSON.stringify(await (await fetch("http://127.0.0.1:3001/status")).json()))'));
      return state.healthy && !state.busy && state.currentImage === secondId && state.previousImage === initial;
    }, "second app version is healthy with recorded rollback image");
    assert.equal((await api("/update/rollback", "POST", "{}")).status, 202);
    await until(async () => {
      const state = JSON.parse(await exec("bun", "-e", 'console.log(JSON.stringify(await (await fetch("http://127.0.0.1:3001/status")).json()))'));
      return state.healthy && !state.busy && state.currentImage === initial && state.previousImage === secondId;
    }, "rollback restores the first app image");
    console.log("PASS: release source validation, private registry credential isolation, two-version pinned app replacement and rollback");
  }
  if (values["installer-system"]) {
    const installerCredentials = await api("/settings/release-registry", "POST", JSON.stringify({ username: "fixture-user", token: "fixture-token" }));
    if (installerCredentials.status !== 200) {
      console.log("Fixture admin registry response:", JSON.stringify(installerCredentials));
      console.log("Fixture System registry status:", await exec("bun", "-e", 'const r=await fetch("http://127.0.0.1:3001/release/registry",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:"fixture-user",token:"fixture-token"})});console.log(r.status);'));
    }
    assert.equal(installerCredentials.status, 200);
    const originalSystem = await run(["docker", "inspect", "--format", "{{.Image}}", name]);
    const originalApp = JSON.parse(await exec("bun", "-e", 'console.log(JSON.stringify(await (await fetch("http://127.0.0.1:3001/status")).json()))')).currentImage;
    const installerApp = `${name}:installer-app`;
    await run(["docker", "exec", "-i", name, "docker", "build", "-t", installerApp, "-"], `FROM ${fixtureApp}\nLABEL org.opencontainers.image.revision="installer-second"\n`);
    const installerAppId = await exec("docker", "image", "inspect", "--format", "{{.Id}}", installerApp);
    await exec("bun", "-e", 'await Bun.write("/data/app/update.json",JSON.stringify({releaseMode:"custom",releaseSource:{appRepository:"ghcr.io/example/fixture-app",systemRepository:"ghcr.io/example/fixture-system"}}));');
    const script = (await Bun.file(new URL("./install.sh", import.meta.url)).text())
      .replace("system_name=kintsugi-system", `system_name=${name}`)
      .replace('{ [ -t 0 ]; } 2>/dev/null <"$prompt_input"', "true")
      .replace('IFS= read -r -t 120 "$1" <"$prompt_input"', 'if [ "$1" = answer ]; then answer=yes; else exit 2; fi')
      .replace("run_root mkdir -p /etc/modules-load.d", "mkdir -p /etc/modules-load.d")
      .replace("run_root tee /etc/modules-load.d", "tee /etc/modules-load.d")
      .replaceAll("/etc/modules-load.d", `${directory}/modules`);
    const path = join(directory, "install.sh"); await Bun.write(path, script);
    await run(["bash", path, "--action", "update", "--system-image", values["installer-system"], "--app-image", installerApp, "--tailscale-hostname", "integration-cloud", "--non-interactive", "--confirm-replace"]);
    assert.equal(await run(["docker", "inspect", "--format", "{{.Config.Hostname}}", name]), "integration-cloud");
    const updated = JSON.parse(await exec("bun", "-e", 'console.log(JSON.stringify(await (await fetch("http://127.0.0.1:3001/status")).json()))'));
    assert.equal(updated.currentImage, installerAppId); assert.equal(updated.healthy, true);
    assert.equal((await api("/settings/release-registry")).body.configured, true);
    assert.equal(await exec("stat", "-c", "%a", "/data/supervisor/docker-auth/config.json"), "600");
    const selected = JSON.parse(await exec("bun", "-e", 'console.log(await Bun.file("/data/app/update.json").text())'));
    assert.equal(selected.releaseSource.appRepository, "ghcr.io/example/fixture-app");
    assert.equal(selected.releaseSource.systemRepository, "ghcr.io/example/fixture-system");
    assert.equal(await run(["docker", "inspect", "--format", mappingTemplate, name]), mapping);
    await run(["bash", path, "--action", "rollback", "--non-interactive", "--confirm-replace"]);
    assert.equal(await run(["docker", "inspect", "--format", "{{.Image}}", name]), originalSystem);
    const restored = JSON.parse(await exec("bun", "-e", 'console.log(JSON.stringify(await (await fetch("http://127.0.0.1:3001/status")).json()))'));
    assert.equal(restored.currentImage, originalApp); assert.equal(restored.healthy, true);
    if (values["proxy-access"]) {
      assert.equal((await api("/settings/access")).body.origin,proxyOrigin);
      assert.equal((await proxyRequest("/workspaces","GET","",true)).status,200);
    }
    console.log("PASS: real host installer pins and replaces System/app, preserves fork source/admin ports/hostname, and restores the retained pair without registry pulls");
  }
  if (storageDriver === "overlayfs") {
    assert.equal(await exec("docker", "exec", "kintsugi", "cat", "/etc/kintsugi/storage.json"), '{"driver":"overlayfs"}');
    const mounts = JSON.parse(await exec("docker", "inspect", "kintsugi"))[0].Mounts;
    assert(!mounts.some((mount: { Destination: string }) => mount.Destination === "/data/erofs-cache"));
    const created = await api("/workspaces", "POST", JSON.stringify({ source: { type: "empty" }, title: "OverlayFS acceptance" }));
    assert.equal(created.status, 202);
    const workspaceId = created.body.workspace.id;
    await until(async () => {
      const current = await api(`/workspaces/${workspaceId}`);
      const phase = current.body.workspace.phase;
      if (phase.status === "failed") throw new Error("OverlayFS workspace provisioning failed");
      return phase.kind === "runningPhase";
    }, "real OverlayFS workspace", 900_000);
    const container = await exec("docker", "ps", "-aq", "--filter", `label=com.kintsugi.workspace-id=${workspaceId}`);
    assert(container);
    const workspaceMounts = JSON.parse(await exec("docker", "inspect", container))[0].Mounts;
    assert(!workspaceMounts.some((mount: { Destination: string }) => mount.Destination === "/data/erofs-cache"));
    assert.equal(await exec("docker", "exec", container, "cat", "/etc/kintsugi/storage.json"), '{"driver":"overlayfs"}');
    if (values["proxy-access"]) {
      await exec("docker","exec",container,"bun","-e",'await Bun.write("/work/issue2-persistence.txt","preserved");');
      assert.equal((await proxyRequest(`/workspaces/${workspaceId}/sidebar-title`,"POST",JSON.stringify({title:"LAN mutation acceptance"}))).status,200);
      assert.equal((await proxyRequest(`/workspaces/${workspaceId}/sidebar-title`,"POST",JSON.stringify({title:"must not apply"}),false,"https://foreign.example")).status,403);
      assert.equal((await api(`/workspaces/${workspaceId}/park?force=1`,"POST","{}")).status,200);
      assert.equal((await api(`/workspaces/${workspaceId}/unpark`,"POST","{}")).status,200);
      await until(async()=>exec("docker","exec",container,"cat","/work/issue2-persistence.txt").then(value=>value==="preserved",()=>false),"workspace persistence after park/unpark");
      await exec("docker","exec","-d",container,"bun","-e",'Bun.serve({hostname:"0.0.0.0",port:37777,fetch(request,server){if(server.upgrade(request))return;if(new URL(request.url).pathname==="/events")return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("data: preview-event\\n\\n"));}}),{headers:{"content-type":"text/event-stream"}});return new Response("issue2-preview");},websocket:{message(ws,message){ws.send(message);}}});');
      await until(async()=>exec("docker","exec",container,"bun","-e","const r=await fetch(\"http://127.0.0.1:37777\");process.exit(r.ok?0:1);").then(()=>true,()=>false),"preview fixture server");
      const published=JSON.parse(await exec("docker","exec",container,"bun","-e",'const r=await fetch("http://parent/origins",{unix:"/run/kintsugi-parent/ingress.sock",method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({port:37777,protocol:"http"})});if(!r.ok)throw Error("Preview publication failed");console.log(await r.text());'));
      assert(published.origin.startsWith("https://127.0.0.1:41"));
      assert.equal((await proxyRequest("/openapi.json","GET","",false,proxyOrigin,published.origin)).body,"issue2-preview");
      assert.equal((await proxyRequest(`/workspaces/${workspaceId}/sidebar-title`,"POST",JSON.stringify({title:"preview must not mutate management"}),false,published.origin)).status,403);
      assert.equal(await proxyStream(published.origin,"/",true),"echo");
      assert((await proxyStream(published.origin,"/events")).includes("preview-event"));
      assert((await proxyStream(proxyOrigin,"/settings/access/events")).includes("event:"));
      const clientToken=join(directory,"client-token.json");await Bun.write(clientToken,JSON.stringify({secret:proxySecret}));await chmod(clientToken,0o600);
      await run(["bun","scripts/verify-lan-client.ts","--ui",proxyOrigin,"--api",proxyApiOrigin,"--ca",join(directory,"proxy-ca.crt"),"--token-file",clientToken,"--out",join(directory,"client-report.json"),"--preview-origin",published.origin,"--confirm-create-workspace"]);
      console.log("PASS: LAN client acceptance helper and disposable lifecycle (local protocol fixture; not a second physical LAN client)");
      const desktop=JSON.parse(await exec("docker","exec",container,"/opt/kintsugi/bin/kintsugi-desktop","start"));assert.equal(desktop.phase,"running");
      const desktopPage=await proxyRequest(`/workspaces/${workspaceId}/apps/desktop/`);assert.equal(desktopPage.status,200);
      const desktopOrigin=new URL(desktopPage.url).origin;assert.notEqual(desktopOrigin,proxyOrigin);assert(desktopOrigin.startsWith("https://127.0.0.1:41"));
      await exec("docker","exec",container,"/opt/kintsugi/bin/kintsugi-desktop","stop");
      console.log("PASS: actual Desktop startup, HTTPS canonical redirect to isolated LAN preview origin, (VNC visual interaction requires physical-client acceptance)");
      console.log("PASS: actual OverlayFS workspace create/park/unpark/persistence, same-origin mutation, preview-origin isolation, WebSockets and unbuffered SSE through CA-verified Caddy");
    }
    assert.equal((await api(`/workspaces/${workspaceId}/delete?force=1`, "POST", "{}")).status, 200);
    console.log("PASS: OverlayFS selection survives System update/rollback, reaches the app/workspace, and omits EROFS mounts");
  }
  const cli = JSON.parse(await exec("docker", "exec", "--user", "1000:1000", "kintsugi", "bun", "/app/apps/web/scripts/admin-bindings.ts", "show"));
  assert.equal(cli.tokens.length, values["proxy-access"] ? 2 : 1);
  // Deliberately corrupt optional configuration, then verify real UI health after app restart.
  await exec("sh", "-c", 'printf "bad JSON" > /data/app/admin-bindings.json');
  await exec("docker", "restart", "--time", "30", "kintsugi");
  await until(async () => (await exec("bun", "-e", 'const r=await fetch("http://127.0.0.1:3000/up");process.exit(r.status===200?0:1)').then(() => true, () => false)), "UI survives corrupt optional admin configuration");
  await run(["docker", "stop", "--time", "60", name]);
  assert.equal(await run(["docker", "inspect", "--format", mappingTemplate, name]), mapping, "persistent mappings survive stopped System");
  console.log("PASS: real System, TLS publication, separate client container, nested CLI, access/status/diagnostics, global settings JSON CRUD, startup isolation, stopped-container publication persistence");
} catch (error) {
  console.error(await run(["docker", "logs", "--tail", "100", name]).catch(() => "System logs unavailable"));
  console.error(await exec("docker", "logs", "--tail", "60", "kintsugi").catch(() => "App logs unavailable"));
  throw error;
} finally {
  await run(["docker", "rm", "-f", caddy]).catch(() => {});
  await run(["docker", "rm", "-f", name]).catch(() => {});
  await run(["docker", "volume", "rm", volume]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}

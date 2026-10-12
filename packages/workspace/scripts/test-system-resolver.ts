import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
// Disposable privileged namespaces; never changes host DNS or live installations.
const root = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const image = process.argv[2];
if (!image || process.argv.length !== 3) throw new Error("Pass a local System image containing Bun, ip and nft");
const directory = await mkdtemp(join(tmpdir(), "system-dns-integration-"));
const name = `kintsugi-system-dns-${crypto.randomUUID()}`;
async function docker(args: string[]) {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, out, error] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  assert.equal(code, 0, error || out);
  return out;
}
const upstream = `import{createSocket}from'node:dgram';
for(const [address,code]of[['10.250.0.53',3],['10.250.0.54',0]]){const s=createSocket('udp4');s.on('message',(q,r)=>{const h=Buffer.from(q.subarray(0,12));const positive=code===0&&q.readUInt16BE(q.length-4)===1;h.writeUInt16BE(0x8180|code,2);h.writeUInt16BE(positive?1:0,6);const a=positive?Buffer.from([192,168,10,20]):undefined;const rr=a?Buffer.from([0xc0,12,0,1,0,1,0,0,0,60,0,4,...a]):Buffer.alloc(0);s.send(Buffer.concat([h,q.subarray(12),rr]),r.port,r.address)});s.bind(53,address)};`;
const probe = `import assert from'node:assert/strict';import dns from'node:dns/promises';import{connect}from'node:net';
const [address,expected,port]=process.argv.slice(2);const allowed=expected==='yes';
if(port){await new Promise(resolve=>{const s=connect({host:address,port:Number(port)});s.setTimeout(250);s.once('connect',()=>{s.destroy();assert.equal(allowed,true);resolve()});s.once('error',()=>{assert.equal(allowed,false);resolve()});s.once('timeout',()=>{s.destroy();assert.equal(allowed,false);resolve()})})}
else{const r=new dns.Resolver({timeout:100,tries:1});r.setServers([address]);let a;try{a=await r.resolve4('printer.local')}catch(e){if(allowed)throw e;}if(allowed)assert.deepEqual(a,['192.168.10.20']);else assert.equal(a,undefined)};`;
const control = `import assert from'node:assert/strict';import{readFile,mkdir}from'node:fs/promises';import{createWorkspaceNetworkControl,workspaceNetworkBridge}from'${root}/images/system/src/workspace-network.ts';import{command}from'${root}/images/system/src/process.ts';
await mkdir('/sys/fs/cgroup/system/build-clients',{recursive:true});const config={cidrs:['192.168.10.0/24'],dns:['10.250.0.53','10.250.0.54'],search:[]};const path='/tmp/policies.json';
async function probe(client,address,expected,port){await command(['ip','netns','exec',client,'bun','/fixtures/probe.js',address,expected,...(port?[String(port)]:[])])}
if(process.argv[2]==='restore'){const before=JSON.parse(await readFile(path,'utf8'));await createWorkspaceNetworkControl('/system/build-clients',path);await probe('one',before.one.resolver,'yes');console.log('PASS saved System resolver restores before Docker startup');process.exit(0)}
await command(['ip','netns','add','lan']);await command(['ip','link','add','uplink','type','veth','peer','name','endpoint']);await command(['ip','link','set','endpoint','netns','lan']);await command(['ip','link','set','uplink','up']);await command(['ip','addr','add','10.250.0.1/24','dev','uplink']);await command(['ip','-n','lan','link','set','lo','up']);await command(['ip','-n','lan','link','set','endpoint','up']);for(const ip of ['10.250.0.53','10.250.0.54'])await command(['ip','-n','lan','addr','add',ip+'/24','dev','endpoint']);
for(const [i,id]of ['one','two','off'].entries()){const bridge=workspaceNetworkBridge(id);await command(['ip','link','add',bridge,'type','bridge']);await command(['ip','addr','add','172.29.'+(i+1)+'.1/24','dev',bridge]);await command(['ip','link','set',bridge,'up']);await command(['ip','netns','add',id]);await command(['ip','link','add','p'+i,'type','veth','peer','name','c'+i]);await command(['ip','link','set','p'+i,'master',bridge]);await command(['ip','link','set','p'+i,'up']);await command(['ip','link','set','c'+i,'netns',id]);await command(['ip','-n',id,'link','set','lo','up']);await command(['ip','-n',id,'link','set','c'+i,'up']);await command(['ip','-n',id,'addr','add','172.29.'+(i+1)+'.2/24','dev','c'+i]);await command(['ip','-n',id,'route','add','default','via','172.29.'+(i+1)+'.1'])}
const child=Bun.spawn(['ip','netns','exec','lan','bun','/fixtures/upstream.js'],{stdout:'inherit',stderr:'inherit'});await Bun.sleep(200);
const request=await createWorkspaceNetworkControl('/system/build-clients',path);assert.equal((await command(['ip','-j','link','show'])).includes('kintsugi-dns'),false);await request({workspaceId:'one',mode:'lan',configuration:{...config,dns:[]}});assert.equal((await command(['ip','-j','link','show'])).includes('kintsugi-dns'),false);console.log('PASS default/empty configuration opens no System DNS listener, including LAN mode');
const one=await request({workspaceId:'one',mode:'lan',configuration:config});const two=await request({workspaceId:'two',mode:'lan',configuration:{...config,dns:['10.250.0.53']}});await probe('one',one.resolver,'yes');await probe('one',one.resolver,'yes',53);await probe('two',two.resolver,'no');await probe('two',one.resolver,'no');await probe('two',one.resolver,'no',53);await probe('off',one.resolver,'no');console.log('PASS native DNS NXDOMAIN fallback, separate snapshot views, TCP/UDP ownership and Off isolation');
await command(['mount','--bind',path,path]);await assert.rejects(request({workspaceId:'one',mode:'off',configuration:{cidrs:[],dns:[],search:[]}}));await command(['umount',path]);await probe('one',one.resolver,'yes');console.log('PASS failed persistence restores the prior DNS view and firewall policy');
const management=Bun.serve({hostname:one.resolver,port:8080,fetch:()=>new Response('management')});await probe('one',one.resolver,'no',8080);management.stop(true);console.log('PASS resolver address grants no management-port access');
await request({workspaceId:'one',mode:'off',configuration:{cidrs:[],dns:[],search:[]}});await probe('one',one.resolver,'no');await request({workspaceId:'two',mode:'off',configuration:{cidrs:[],dns:[],search:[]}});assert.equal((await command(['ip','-j','link','show'])).includes('kintsugi-dns'),false);console.log('PASS Off revokes DNS and removes all listeners and the internal interface');await request({workspaceId:'one',mode:'lan',configuration:config});process.exit(0);`;
try {
  await writeFile(join(directory, "control.ts"), control);
  await writeFile(join(directory, "upstream.js"), upstream);
  await writeFile(join(directory, "probe.js"), probe);
  const result = await Bun.build({ entrypoints: [join(directory, "control.ts")], target: "bun", outdir: directory });
  assert.equal(result.success, true, String(result.logs));
  await docker(["run", "--name", name, "--privileged", "--security-opt", "writable-cgroups=true", "--mount", `type=bind,src=${directory},dst=/fixtures,readonly`, "--entrypoint", "sh", image, "-ec", "bun /fixtures/control.js init; bun /fixtures/control.js restore"]);
  console.log(await docker(["logs", name]));
} finally {
  const p = Bun.spawn(["docker", "rm", "-f", name], { stdout: "pipe", stderr: "pipe" });
  console.log((await new Response(p.stdout).text()).trim());
  await p.exited;
  await rm(directory, { recursive: true, force: true });
}

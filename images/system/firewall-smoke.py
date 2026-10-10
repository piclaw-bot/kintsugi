#!/usr/bin/env python3
"""Linux Docker host: firewall-smoke.py SYSTEM_IMAGE APP_TAR.
Uses an isolated System and isolated outer uplink. Public address ranges below
are test routes confined to that uplink, not traffic to the real address owners.
"""
import json,pathlib,subprocess,sys,tempfile,time
image,archive=sys.argv[1:]
name='kintsugi-firewall-test';uplink=name+'-uplink';endpoint=name+'-endpoint'
workers=[]
def run(*args,check=True,**kwargs):
 p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs)
 if check and p.returncode:raise RuntimeError(' '.join(args)+'\n'+p.stderr.decode())
 return p
def docker(*args,**kwargs):return run('docker',*args,**kwargs)
def system(*args,**kwargs):return docker('exec',name,*args,**kwargs)
def inner(*args,**kwargs):return system('docker',*args,**kwargs)
def until(test,seconds=90):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  try:
   if test():return
  except RuntimeError:pass
  time.sleep(.25)
 raise AssertionError('condition timed out')
def jsfetch(url):return 'console.log(await(await fetch('+json.dumps(url)+',{signal:AbortSignal.timeout(1200)})).text())'
def query(worker,url,allowed=True):
 p=inner('exec',worker,'bun','-e',jsfetch(url),check=False)
 assert (p.returncode==0)==allowed,(worker,url,p.stdout.decode(),p.stderr.decode())
 return p.stdout.decode().strip()
def sysquery(url):return system('bun','-e',jsfetch(url)).stdout.decode().strip()
def policy():return system('nft','-s','list','table','inet','kintsugi_workspaces').stdout.decode()
def drops():
 entries=json.loads(system('nft','-j','list','table','inet','kintsugi_workspaces').stdout)['nftables'];total=0
 for entry in entries:
  rule=entry.get('rule',{});expressions=rule.get('expr',[])
  if any('drop' in e for e in expressions):total+=sum(e.get('counter',{}).get('packets',0) for e in expressions)
 return total
def serve_script(text,port=8080):return 'Bun.serve({hostname:"::",port:'+str(port)+',fetch:()=>new Response('+json.dumps(text)+')})'
def create_worker(number,kind="workspace"):
 net=f'firewall-workspace-{number}';worker=f'fw-workspace-{number}'
 if kind=='default':net='bridge'
 else:
  options=[] if kind=='generated' else ['--opt',f'com.docker.network.bridge.name={"atw-test" if kind=="workspace" else "untrusted"}{number}']
  inner('network','create','--ipv6','--subnet',f'172.28.{number}.0/24','--subnet',f'fd12:3456:{number}::/64',*options,net)
 inner('run','-d','--name',worker,'--network',net,'--entrypoint','bun','--mount','type=bind,src=/data/firewall-uds,dst=/run/kintsugi-parent,readonly',image,'-e',serve_script(worker));workers.append(worker)
 info=json.loads(inner('inspect',worker).stdout)[0]['NetworkSettings']['Networks'][net]
 until(lambda:sysquery(f'http://{info["IPAddress"]}:8080')==worker)
 return worker,info
try:
 # A firewall-install failure must leave System inert: the failure is reported,
 # and no Docker daemon ever starts, so no workspace can be restored without the firewall.
 with tempfile.TemporaryDirectory(prefix='kintsugi-firewall-') as directory:
  executable=pathlib.Path(directory)/'nft'
  executable.write_text('#!/bin/sh\necho simulated-nft-failure >&2\nexit 23\n');executable.chmod(0o755)
  failed_name=name+'-firewall-failure'
  docker('run','-d','--privileged','--cgroupns=host','--tmpfs','/run','--mount',f'type=bind,src={executable},dst=/usr/sbin/nft,readonly','--name',failed_name,image,'--app-image','kintsugi-test:v2')
  def failure_reported():
   logs=run('docker','logs',failed_name,check=False)
   return b'Could not install workspace firewall: simulated-nft-failure' in logs.stdout+logs.stderr
  until(failure_reported,60)
  daemon_info=docker('exec',failed_name,'docker','info',check=False)
  assert daemon_info.returncode!=0,'dockerd must not start without the workspace firewall'
  docker('rm','-f',failed_name)
 print('PASS firewall install failure stops System explicitly',flush=True)
 docker('network','create','--ipv6','--subnet','11.200.0.0/24','--subnet','2001:4860:ffff:dead::/64',uplink)
 docker('run','-d','--name',endpoint,'--network',uplink,'--ip','11.200.0.2','--ip6','2001:4860:ffff:dead::2','--cap-add','NET_ADMIN','--entrypoint','bun',image,'-e',serve_script('external'))
 for address in ('10.200.0.2/32','100.64.0.2/32','169.254.169.254/32','fd99::2/128','fd7a:115c:a1e0::2/128'):
  docker('exec',endpoint,'ip','addr','add',address,'dev','eth0')
 docker('run','-d','--name',name,'--privileged','--cgroupns=host','--restart','unless-stopped','--network',uplink,'--ip','11.200.0.3','--ip6','2001:4860:ffff:dead::3','--tmpfs','/run','--mount',f'source={name},target=/data',image,'--app-image','kintsugi-test:v2')
 until(lambda:inner('info',check=False).returncode==0)
 # Default Docker pools used to exhaust after roughly 30 workspaces. Exercise
 # automatic allocation beyond that limit, not explicit test-only subnets.
 capacity_networks=[f'capacity-{number}' for number in range(64)]
 for network in capacity_networks:inner('network','create',network)
 allocated=json.loads(inner('network','inspect',*capacity_networks).stdout)
 subnets=[network['IPAM']['Config'][0]['Subnet'] for network in allocated]
 assert len(set(subnets))==64 and all(subnet.endswith('/24') for subnet in subnets),subnets
 inner('network','rm',*capacity_networks)
 print('PASS 64 automatically allocated /24 workspace networks',flush=True)
 # Reuse actual built image locally, no registry credentials needed.
 source=subprocess.Popen(['docker','save',image],stdout=subprocess.PIPE)
 docker('exec','-i',name,'docker','load',stdin=source.stdout);assert source.wait()==0
 with open(archive,'rb') as file:docker('exec','-i',name,'docker','load',stdin=file)
 until(lambda:not json.loads(sysquery('http://127.0.0.1:3001/status'))['busy'])
 system('bun','-e','await fetch("http://127.0.0.1:3001/update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({image:"kintsugi-test:v2"})})')
 until(lambda:json.loads(sysquery('http://127.0.0.1:3001/status'))['healthy'])
 system('mkdir','-p','/data/firewall-uds')
 def setup_routes_and_socket():
  for target in ('10.200.0.2/32','100.64.0.2/32','169.254.169.254/32'):system('ip','route','replace',target,'via','11.200.0.2')
  for target in ('fd99::2/128','fd7a:115c:a1e0::2/128'):system('ip','-6','route','replace',target,'via','2001:4860:ffff:dead::2')
  # The lifecycle test app binds loopback. Use a reachable, harmless management
  # fixture so a connection refusal cannot masquerade as firewall enforcement.
  docker('exec','-d',name,'bun','-e',serve_script('system-only')+';'+serve_script('management-fixture',3002))
  system('rm','-f','/data/firewall-uds/parent.sock')
  docker('exec','-d',name,'bun','-e','Bun.serve({unix:"/data/firewall-uds/parent.sock",fetch:()=>new Response("parent-socket")})')
 setup_routes_and_socket()
 a,ai=create_worker(1);b,bi=create_worker(2)
 before=policy()
 def checks(worker,info,peer):
  start=drops()
  assert query(worker,'http://11.200.0.2:8080')=='external'
  if info['GlobalIPv6Address']:assert query(worker,'http://[2001:4860:ffff:dead::2]:8080')=='external'
  query(worker,'https://example.com') # actual public DNS + HTTPS, Docker NAT
  for host in (info['Gateway'],info['IPv6Gateway']):
   if not host:continue
   url=f'http://[{host}]:8080' if ':' in host else f'http://{host}:8080'
   assert sysquery(url)=='system-only';query(worker,url,False)
  for ip in (peer['IPAddress'],peer['GlobalIPv6Address']):query(worker,f'http://[{ip}]:8080' if ':' in ip else f'http://{ip}:8080',False)
  for ip in ('10.200.0.2','100.64.0.2','169.254.169.254','fd99::2','fd7a:115c:a1e0::2'):
   url=f'http://[{ip}]:8080' if ':' in ip else f'http://{ip}:8080'
   assert sysquery(url)=='external';query(worker,url,False)
  assert sysquery(f'http://{info["IPAddress"]}:8080')==worker
  if info['GlobalIPv6Address']:assert sysquery(f'http://[{info["GlobalIPv6Address"]}]:8080')==worker
  result=inner('exec',worker,'bun','-e','console.log(await(await fetch("http://parent",{unix:"/run/kintsugi-parent/parent.sock"})).text())').stdout.decode().strip()
  assert result=='parent-socket'
  # Local delivery is denied even when the System's destination IP is public.
  query(worker,'http://11.200.0.3:8080',False)
  # A harmless POST with a forged matching Origin must not reach management.
  origin=f'http://{info["Gateway"]}:3002'
  assert sysquery(origin+'/state')=='management-fixture'
  probe='try { await fetch('+json.dumps(origin+'/state')+',{method:"POST",headers:{Origin:'+json.dumps(origin)+'},signal:AbortSignal.timeout(1200)}); process.exit(1) } catch { console.log("blocked") }'
  assert inner('exec',worker,'bun','-e',probe).stdout.decode().strip()=='blocked'
  assert drops()>start,'denials must hit Kintsugi rules, not merely Docker bridge isolation'
 checks(a,ai,bi);checks(b,bi,ai)
 c,ci=create_worker(3);checks(c,ci,ai);assert policy()==before
 d,di=create_worker(4,'default');checks(d,di,ai)
 e,ei=create_worker(5,'generated');checks(e,ei,ai)
 f,fi=create_worker(6,'custom');checks(f,fi,ai)
 assert policy()==before
 def build_checks():
  # A real uncached BuildKit RUN on its default network, with no network flag.
  # Public HTTP must work; gateway/private/metadata/System-public-IP must not.
  urls=[f'http://{di["Gateway"]}:3002/state','http://11.200.0.3:8080','http://10.200.0.2:8080','http://100.64.0.2:8080','http://169.254.169.254:8080',f'http://{ai["IPAddress"]}:8080']
  script='if(await(await fetch("http://11.200.0.2:8080")).text()!=="external")throw Error("public egress failed");'
  script+='for(const url of '+json.dumps(urls)+'){let blocked=false;try{await fetch(url,{method:"POST",headers:{Origin:new URL(url).origin},signal:AbortSignal.timeout(1200)})}catch{blocked=true}if(!blocked)throw Error("reachable: "+url)}console.log("build isolation passed")'
  dockerfile='FROM '+image+'\nRUN '+json.dumps(['bun','-e',script])+'\n'
  start=drops()
  result=docker('exec','-i',name,'env','DOCKER_BUILDKIT=1','docker','build','--no-cache','--progress=plain','-',input=dockerfile.encode())
  assert b'build isolation passed' in result.stdout+result.stderr
  assert drops()>start
 build_checks()
 # Publishing a peer's port must not bypass the forward-chain boundary via DNAT.
 inner('run','-d','--name','fw-published','--network','firewall-workspace-1','-p','18080:8080','--entrypoint','bun',image,'-e',serve_script('published-peer'));workers.append('fw-published')
 until(lambda:sysquery('http://11.200.0.3:18080')=='published-peer')
 for worker in (a,d,e,f):query(worker,'http://11.200.0.3:18080',False)
 print('PASS published peer port is blocked through the System public address',flush=True)
 print('PASS default-bridge Dockerfile RUN and docker run, generated/custom bridges, forged Origin, public System address and metadata isolation',flush=True)
 print('PASS IPv4/IPv6 public egress, DNS/NAT, gateway replies, Unix sockets; private/tailnet blocked; System/peer blocked; third bridge automatically isolated',flush=True)
 # A daemon failure causes supervised System restart; rules reinstall before children start.
 started=json.loads(docker('inspect',name).stdout)[0]['State']['StartedAt']
 system('bun','-e','for(const p of new Bun.Glob("/proc/[0-9]*/comm").scanSync()){if((await Bun.file(p).text()).trim()==="dockerd")process.kill(Number(p.split("/")[2]),"SIGTERM")}',check=False)
 until(lambda:json.loads(docker('inspect',name).stdout)[0]['State']['StartedAt']!=started)
 until(lambda:inner('info',check=False).returncode==0)
 until(lambda:json.loads(sysquery('http://127.0.0.1:3001/status'))['healthy'])
 setup_routes_and_socket()
 for worker in workers:inner('start',worker)
 checks(c,ci,ai);checks(d,di,ai);checks(e,ei,ai);checks(f,fi,ai);build_checks();assert policy()==before
 print('PASS daemon/System restart restores static policy and leaves Docker rules intact',flush=True)
finally:
 docker('rm','-f',name,endpoint,check=False);docker('volume','rm',name,check=False);docker('network','rm',uplink,check=False)

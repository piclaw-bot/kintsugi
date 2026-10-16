import {mkdir,readFile,writeFile} from 'node:fs/promises';import{join}from'node:path';
import{initializeResources}from'../src/resources.ts';
const root=process.argv[2]!;
await writeFile(join(root,'cgroup.procs'),String(process.pid));
await mkdir('/data/supervisor',{recursive:true});await writeFile('/data/supervisor/storage.json',JSON.stringify({driver:'overlayfs'}));
const result=await initializeResources();
if(result.effectiveMemory!==3*1024**3||(await readFile(join(root,'memory.max'),'utf8')).trim()!==String(3*1024**3)||(await readFile(join(root,'memory.swap.max'),'utf8')).trim()!=='0')throw Error('Older unbounded installer did not receive a finite budget');
const saved=JSON.parse(await readFile('/data/supervisor/system-resource-policy.json','utf8'));if(saved.memory!==result.effectiveMemory||saved.memorySwap!==saved.memory)throw Error('Runtime budget was not retained');
console.log(JSON.stringify({runtimeBootstrapBudget:true,effectiveMemoryGiB:3,additionalSwap:0,source:'previously unbounded child cgroup under a 4 GiB test parent'}));

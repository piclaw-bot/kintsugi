import { expect,test } from "bun:test";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import { requiredAppResourceStateVersion,requiredResourceStateVersion,assertResourceStateCompatible } from "../src/resource-compatibility.ts";
import {resourcePolicyVersionLabel,systemVersionLabel} from "../src/system-version.ts";

test("configured resource markers require a reader without changing network format or empty-install compatibility",async()=>{
  const root=await mkdtemp(join(tmpdir(),"resource-compatibility-"));const app=join(root,"app"),directory=join(app,"workspaces","fixture","metadata");
  try{
    expect(await requiredResourceStateVersion(root)).toBe(0);await mkdir(directory,{recursive:true});await writeFile(join(directory,"resource-policy.json"),JSON.stringify({version:1}));
    expect(await requiredResourceStateVersion(root)).toBe(1);expect(await requiredAppResourceStateVersion(app)).toBe(1);
    expect(()=>assertResourceStateCompatible(0,{},{})).not.toThrow();
    expect(()=>assertResourceStateCompatible(1,{[resourcePolicyVersionLabel]:"1"},{[systemVersionLabel]:"3"})).not.toThrow();
    expect(()=>assertResourceStateCompatible(1,{}, {[systemVersionLabel]:"3"})).toThrow("resource-aware");
    expect(()=>assertResourceStateCompatible(1,{[resourcePolicyVersionLabel]:"1"},{[systemVersionLabel]:"2"})).toThrow("resource-aware");
    await rm(join(app,"workspaces","fixture"),{recursive:true});expect(await requiredResourceStateVersion(root)).toBe(0);
  }finally{await rm(root,{recursive:true,force:true});}
});
test("malformed markers do not silently authorise a downgrade",async()=>{
  const root=await mkdtemp(join(tmpdir(),"resource-compatibility-invalid-"));const directory=join(root,"workspaces","fixture","metadata");
  try{await mkdir(directory,{recursive:true});await writeFile(join(directory,"resource-policy.json"),'{"version":0}');await expect(requiredAppResourceStateVersion(root)).rejects.toThrow();}finally{await rm(root,{recursive:true,force:true});}
});

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileOriginIdentityStore } from "../src/ingress/origin-identity.ts";

test("expanding a full legacy pool preserves assigned and retired identities across restart", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"origin-expansion-"));const path=join(dir,"origins.json");
  try{
    let store=createFileOriginIdentityStore(path);const small={start:41000,end:41009};
    for(let i=0;i<10;i++)expect((await store.assignedPort({workspaceId:`ws${i}`,appKey:"preview"},small)).port).toBe(41000+i);
    await store.removeWorkspace("ws4");
    await expect(store.assignedPort({workspaceId:"new",appKey:"preview"},small)).rejects.toThrow("capacity exhausted");
    store=createFileOriginIdentityStore(path);
    expect(await store.assignedPort({workspaceId:"ws0",appKey:"preview"},{start:41000,end:41999})).toEqual({port:41000,fresh:false});
    expect(await store.assignedPort({workspaceId:"new",appKey:"preview"},{start:41000,end:41999})).toEqual({port:41010,fresh:true});
    const saved=JSON.parse(await readFile(path,"utf8"));expect(saved.version).toBe(2);expect(saved.retiredPorts).toContain(41004);expect(saved.assignments.find((x:{app:{workspaceId:string}})=>x.app.workspaceId==="ws9").port).toBe(41009);
  }finally{await rm(dir,{recursive:true,force:true});}
});

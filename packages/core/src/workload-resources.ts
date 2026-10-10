import { readTextIfExists } from "./fs.ts";
const descriptor = "/run/kintsugi-system/resources.json";
async function resources(): Promise<
  { workloadsCgroupParent: string } | undefined
> {
  const text = await readTextIfExists(descriptor);
  // A developer's local Docker context has no System-owned workload group.
  return text === undefined ? undefined : JSON.parse(text);
}
export async function workloadCgroupArgs(): Promise<string[]> {
  const config = await resources();
  return config ? ["--cgroup-parent", config.workloadsCgroupParent] : [];
}
export async function workloadCommand(args: string[]): Promise<string[]> {
  if (!(await resources())) return args;
  // Move only this child before exec; the app and its other requests stay protected.
  return [
    "sh",
    "-ec",
    'echo $$ > /run/kintsugi-system/workload-processes/cgroup.procs; exec "$@"',
    "kintsugi-workload",
    ...args,
  ];
}

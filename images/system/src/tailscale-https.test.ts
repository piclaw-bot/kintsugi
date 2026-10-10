import { expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { TailscaleHttps, TailscaleCertificateError } from "./tailscale-https.ts";

const host = "kintsugi.example.ts.net";
test("disabled HTTPS blocks provisioning, then recovers and verifies once per host", async () => {
  const calls: string[][] = [];
  const https = new TailscaleHttps(async (args, _output, timeout) => {
    calls.push(args);
    expect(timeout).toBe(180_000);
    await access(dirname(args[3]!));
    return "certificate provisioned";
  });
  await expect(https.prepare(host, [])).rejects.toThrow("enable MagicDNS and HTTPS Certificates");
  expect(calls).toHaveLength(0);
  await https.prepare(host, [host]);
  expect(calls[0]!.slice(0, 3)).toEqual(["tailscale", "cert", "--cert-file"]);
  expect(calls[0]![4]).toBe("--key-file");
  expect(calls[0]![6]).toBe(host);
  await expect(access(dirname(calls[0]![3]!))).rejects.toThrow();
  await https.prepare(host, [host]);
  expect(calls).toHaveLength(1);
  await expect(https.prepare(host, null)).rejects.toThrow("HTTPS certificates are not enabled");
  await https.prepare(host, [host]);
  expect(calls).toHaveLength(2);
  await https.prepare("other.example.ts.net", ["other.example.ts.net"]);
  expect(calls).toHaveLength(3);
  https.reset();
  await https.prepare("other.example.ts.net", ["other.example.ts.net"]);
  expect(calls).toHaveLength(4);
});

test("provisioning failures preserve details, clean up private files, and retry", async () => {
  let fail = true;
  let certFile = "";
  const https = new TailscaleHttps(async (args) => {
    certFile = args[3]!;
    if (fail) throw new Error("certificate authority unreachable");
    return "";
  });
  await expect(https.prepare(host, [host])).rejects.toThrow(TailscaleCertificateError);
  await expect(https.prepare(host, [host])).rejects.toThrow("certificate authority unreachable");
  await expect(access(dirname(certFile))).rejects.toThrow();
  fail = false;
  await https.prepare(host, [host]);
});

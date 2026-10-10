// Wire contract with workspace-image/workspace-image/gateway/main.go.
export const workspaceGatewayPort = 2999;
export const workspaceGatewayHostHeader = "x-kintsugi-gateway-host";
export const workspaceGatewayTokenHeader = "x-kintsugi-gateway-token";
export const workspaceGatewayPortHeader = "x-kintsugi-gateway-port";
export const workspaceGatewayProtocolHeader = "x-kintsugi-gateway-protocol";

// Response-only marker, stripped from app responses by the gateway.
export const workspaceGatewayErrorHeader = "x-kintsugi-gateway-error";

export function isWorkspaceAppPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535 && port !== workspaceGatewayPort;
}

const plainLoopbackHosts = ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"];
const localhostSubdomainPattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+localhost$/;

/** The normalized name when hostname is a *.localhost subdomain. */
export function localhostSubdomain(hostname: string): string | undefined {
  const normalized = hostname.toLowerCase();
  return localhostSubdomainPattern.test(normalized) ? normalized : undefined;
}

/** Hosts that reach the workspace itself, including *.localhost names routed by Host header. */
export function isWorkspaceLoopbackHost(hostname: string): boolean {
  return plainLoopbackHosts.includes(hostname.toLowerCase()) || localhostSubdomain(hostname) !== undefined;
}

/** A *.localhost name gets its own app, and so its own browser origin, per port. */
export function workspacePortAppKey(port: number, hostname = "localhost"): string {
  if (!isWorkspaceLoopbackHost(hostname)) throw new Error(`Not a workspace loopback host: ${hostname}`);
  const subdomain = localhostSubdomain(hostname);
  return subdomain ? `port-${port}@${subdomain}` : `port-${port}`;
}

export function parseWorkspacePortAppKey(appKey: string): { port: number; host?: string } | undefined {
  const match = appKey.match(/^port-(\d+)(?:@(.+))?$/);
  if (!match || (match[2] !== undefined && localhostSubdomain(match[2]) !== match[2])) return undefined;
  return { port: Number(match[1]), host: match[2] };
}

export interface WorkspaceGateway {
  /** Docker-host loopback URL of the workspace's sole published gateway. */
  url: URL;
  token: string;
}

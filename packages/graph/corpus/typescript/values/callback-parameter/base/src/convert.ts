import { Registry, Server } from "./server";

export function convert(servers: Server[]): string[][] {
  return servers.map((server) => server.listTools());
}

export function loop(registry: Registry): void {
  for (const server of registry.all()) server.listTools();
}

export function direct(servers: Server[]): void {
  for (const server of servers) server.listTools();
}

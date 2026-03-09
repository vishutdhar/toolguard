#!/usr/bin/env node

/**
 * ToolGuard MCP Gateway CLI
 *
 * Usage:
 *   toolguard-mcp --config <config.json> -- <command> [args...]
 *
 * Example:
 *   toolguard-mcp --config toolguard.json -- npx @modelcontextprotocol/server-slack
 *
 * The gateway wraps any MCP server and enforces ToolGuard authorization on
 * every tool call before forwarding to the upstream server.
 *
 * Environment variables:
 *   TOOLGUARD_API_KEY  — ToolGuard API key (preferred over config file)
 */

import { readFileSync } from "node:fs";
import { ToolGuardGateway } from "./gateway.js";
import type { GatewayConfig } from "./types.js";

function usage(): never {
  console.error(
    "Usage: toolguard-mcp --config <config.json> -- <command> [args...]",
  );
  console.error("");
  console.error("Example:");
  console.error(
    "  toolguard-mcp --config toolguard.json -- npx @modelcontextprotocol/server-slack",
  );
  console.error("");
  console.error("Environment variables:");
  console.error(
    "  TOOLGUARD_API_KEY  — ToolGuard API key (preferred over config file)",
  );
  process.exit(1);
}

const args = process.argv.slice(2);

const configIdx = args.indexOf("--config");
const separatorIdx = args.indexOf("--");

if (configIdx === -1 || separatorIdx === -1 || separatorIdx <= configIdx + 1) {
  usage();
}

const configPath = args[configIdx + 1];
if (!configPath) usage();

const upstreamCommand = args[separatorIdx + 1];
if (!upstreamCommand) usage();

const upstreamArgs = args.slice(separatorIdx + 2);

// Load config
let config: GatewayConfig;
try {
  config = JSON.parse(readFileSync(configPath, "utf-8")) as GatewayConfig;
} catch (err) {
  console.error(
    `Failed to read config file ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

// Start gateway
const gateway = new ToolGuardGateway(config, {
  command: upstreamCommand,
  args: upstreamArgs,
});

gateway.start().catch((err) => {
  console.error(`Gateway failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
  gateway.close().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  gateway.close().then(() => process.exit(0));
});

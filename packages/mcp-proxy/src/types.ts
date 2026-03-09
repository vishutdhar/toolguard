/**
 * Configuration for the ToolGuard MCP Gateway.
 *
 * The gateway sits between an MCP client (e.g. Claude, Cursor) and an upstream
 * MCP server, intercepting every `tools/call` and routing it through ToolGuard's
 * policy engine before forwarding to the upstream server.
 */

export interface GatewayConfig {
  /** ToolGuard API connection. API key must be set via TOOLGUARD_API_KEY env var. */
  toolguard: {
    baseUrl: string;
    orgId: string;
    agentId: string;
  };

  /** Session parameters for ToolGuard authorization. */
  session: {
    environment: string;
    scopes: string[];
    userId?: string;
  };

  /**
   * Maps MCP tool names to ToolGuard catalog names.
   * If a tool is not listed here, the MCP name is used as-is.
   *
   * Example: { "read_file": "filesystem.read", "run_command": "shell.execute" }
   */
  toolMapping?: Record<string, string>;
}

/** Upstream MCP server spawn configuration. */
export interface UpstreamConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

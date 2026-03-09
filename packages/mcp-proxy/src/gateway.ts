/**
 * ToolGuard MCP Gateway
 *
 * A transparent proxy between an MCP client and an upstream MCP server.
 * All MCP methods are passed through unchanged EXCEPT `tools/call`, which
 * is intercepted and authorized through ToolGuard's policy engine.
 *
 * Architecture:
 *   [MCP Client] <--stdio--> [ToolGuard Gateway] <--stdio--> [Upstream MCP Server]
 */

import { Server } from "@modelcontextprotocol/sdk/server";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CompleteRequestSchema,
  SetLevelRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolGuard } from "@toolguard/client";
import type { GatewayConfig, UpstreamConfig } from "./types.js";

export interface GatewayOptions {
  /** Inject a pre-configured ToolGuard client (skips env var check). For testing. */
  toolguardClient?: ToolGuard;
}

export interface StartOptions {
  /** Override the upstream transport (default: StdioClientTransport from upstreamConfig). */
  upstreamTransport?: Transport;
  /** Override the client-facing transport (default: StdioServerTransport on stdin/stdout). */
  clientTransport?: Transport;
}

export class ToolGuardGateway {
  private upstream: Client;
  private proxy: Server;
  private tg: ToolGuard;
  private sessionId: string | undefined;
  private config: GatewayConfig;
  private upstreamConfig: UpstreamConfig;

  constructor(
    config: GatewayConfig,
    upstreamConfig: UpstreamConfig,
    options?: GatewayOptions,
  ) {
    this.config = config;
    this.upstreamConfig = upstreamConfig;

    if (options?.toolguardClient) {
      this.tg = options.toolguardClient;
    } else {
      const apiKey = process.env.TOOLGUARD_API_KEY;
      if (!apiKey) {
        throw new Error(
          "TOOLGUARD_API_KEY environment variable is required.",
        );
      }

      this.tg = new ToolGuard({
        apiKey,
        baseUrl: config.toolguard.baseUrl,
        orgId: config.toolguard.orgId,
        agentId: config.toolguard.agentId,
      });
    }

    // Placeholders — initialized in start() after upstream capabilities are known
    this.upstream = null as unknown as Client;
    this.proxy = null as unknown as Server;
  }

  /**
   * Start the gateway:
   * 1. Connect to upstream MCP server and discover its capabilities
   * 2. Create a proxy Server advertising those same capabilities
   * 3. Wire up passthrough + authorization handlers
   * 4. Connect the proxy to the client-facing transport
   */
  async start(options?: StartOptions): Promise<void> {
    // 1. Connect to upstream
    this.upstream = new Client(
      { name: "toolguard-gateway", version: "0.1.0" },
      {},
    );

    const upstreamTransport =
      options?.upstreamTransport ??
      new StdioClientTransport({
        command: this.upstreamConfig.command,
        args: this.upstreamConfig.args,
        env: this.upstreamConfig.env
          ? ({ ...process.env, ...this.upstreamConfig.env } as Record<
              string,
              string
            >)
          : undefined,
        stderr: "inherit",
      });

    await this.upstream.connect(upstreamTransport);

    // 2. Mirror upstream capabilities
    const upstreamCaps = this.upstream.getServerCapabilities() ?? {};
    const capabilities: ServerCapabilities = {};

    if (upstreamCaps.tools) {
      capabilities.tools = { listChanged: !!upstreamCaps.tools.listChanged };
    }
    if (upstreamCaps.resources) {
      capabilities.resources = {
        subscribe: !!upstreamCaps.resources.subscribe,
        listChanged: !!upstreamCaps.resources.listChanged,
      };
    }
    if (upstreamCaps.prompts) {
      capabilities.prompts = {
        listChanged: !!upstreamCaps.prompts.listChanged,
      };
    }
    if (upstreamCaps.logging) {
      capabilities.logging = upstreamCaps.logging;
    }
    if (upstreamCaps.completions) {
      capabilities.completions = upstreamCaps.completions;
    }

    // 3. Create proxy server
    const upstreamInfo = this.upstream.getServerVersion();
    const serverName = upstreamInfo
      ? `toolguard → ${upstreamInfo.name}`
      : "toolguard-gateway";

    this.proxy = new Server(
      { name: serverName, version: "0.1.0" },
      {
        capabilities,
        instructions: this.upstream.getInstructions(),
      },
    );

    // 4. Wire handlers
    this.registerHandlers(upstreamCaps);

    // 5. Connect to client-facing transport
    const clientTransport = options?.clientTransport ?? new StdioServerTransport();
    await this.proxy.connect(clientTransport);
  }

  /** Shut down both connections cleanly. */
  async close(): Promise<void> {
    await this.proxy?.close();
    await this.upstream?.close();
  }

  // ---------------------------------------------------------------------------
  // Handler registration
  // ---------------------------------------------------------------------------

  private registerHandlers(caps: ServerCapabilities): void {
    // --- Tools (always register if upstream supports) ---
    if (caps.tools) {
      this.proxy.setRequestHandler(ListToolsRequestSchema, async (request) => {
        return this.upstream.listTools(request.params);
      });

      this.proxy.setRequestHandler(CallToolRequestSchema, async (request) => {
        return this.handleToolCall(request.params);
      });
    }

    // --- Resources passthrough ---
    if (caps.resources) {
      this.proxy.setRequestHandler(
        ListResourcesRequestSchema,
        async (request) => {
          return this.upstream.listResources(request.params);
        },
      );

      this.proxy.setRequestHandler(
        ListResourceTemplatesRequestSchema,
        async (request) => {
          return this.upstream.listResourceTemplates(request.params);
        },
      );

      this.proxy.setRequestHandler(
        ReadResourceRequestSchema,
        async (request) => {
          return this.upstream.readResource(request.params);
        },
      );
    }

    // --- Prompts passthrough ---
    if (caps.prompts) {
      this.proxy.setRequestHandler(
        ListPromptsRequestSchema,
        async (request) => {
          return this.upstream.listPrompts(request.params);
        },
      );

      this.proxy.setRequestHandler(
        GetPromptRequestSchema,
        async (request) => {
          return this.upstream.getPrompt(request.params);
        },
      );
    }

    // --- Completions passthrough ---
    if (caps.completions) {
      this.proxy.setRequestHandler(CompleteRequestSchema, async (request) => {
        return this.upstream.complete(request.params);
      });
    }

    // --- Logging passthrough ---
    if (caps.logging) {
      this.proxy.setRequestHandler(SetLevelRequestSchema, async (request) => {
        return this.upstream.setLoggingLevel(request.params.level);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Tool call authorization gate
  // ---------------------------------------------------------------------------

  private async handleToolCall(
    params: { name: string; arguments?: Record<string, unknown> },
  ) {
    const mcpToolName = params.name;
    const toolguardName = this.config.toolMapping?.[mcpToolName] ?? mcpToolName;

    // Lazy session creation
    if (!this.sessionId) {
      try {
        const session = await this.tg.createSession({
          environment: this.config.session.environment,
          scopes: this.config.session.scopes,
          userId: this.config.session.userId,
        });
        this.sessionId = session.id;
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `ToolGuard session creation failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Authorize through ToolGuard
    let decision;
    try {
      decision = await this.tg.authorize({
        sessionId: this.sessionId,
        tool: { name: toolguardName },
        context: {},
        payloadSummary: params.arguments ?? {},
      });
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `ToolGuard authorization failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }

    // Denied
    if (decision.decision === "deny") {
      const reasons = decision.reasonCodes.join(", ");
      return {
        content: [
          {
            type: "text",
            text: `Tool call denied by policy. Reasons: ${reasons}`,
          },
        ],
        isError: true,
      };
    }

    // Requires approval
    if (decision.decision === "require_approval") {
      return {
        content: [
          {
            type: "text",
            text: `Tool call requires human approval (approval ID: ${decision.approvalId}). The request has been queued — contact your administrator to approve it.`,
          },
        ],
        isError: true,
      };
    }

    // Allowed — forward to upstream
    return this.upstream.callTool(params);
  }
}

/**
 * OpenAI Agent with ToolGuard Authorization
 *
 * This example runs a support agent that can:
 * - Post internal Slack messages (allowed)
 * - Send external emails (requires approval)
 * - Issue refunds over $1000 (denied)
 *
 * Every tool call is authorized through ToolGuard before execution.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npm run example:openai
 *
 * Prerequisites:
 *   1. ToolGuard server running: npm run dev (or docker compose up)
 *   2. Seed demo data: npm run seed
 *   3. Set TOOLGUARD_API_KEY from seed output
 */

import OpenAI from "openai";
import { ToolGuard } from "@toolguard/client";
import { createGuardedExecutor } from "@toolguard/openai";
import type { GuardedToolMap } from "@toolguard/openai";
import type { ChatCompletionTool, ChatCompletionMessageParam } from "openai/resources/chat/completions";

// --- Configuration ---

const TOOLGUARD_API_KEY = process.env.TOOLGUARD_API_KEY;
const TOOLGUARD_URL = process.env.TOOLGUARD_URL ?? "http://localhost:3000";
const TOOLGUARD_ORG_ID = process.env.TOOLGUARD_ORG_ID;
const TOOLGUARD_AGENT_ID = process.env.TOOLGUARD_AGENT_ID;

if (!TOOLGUARD_API_KEY || !TOOLGUARD_ORG_ID || !TOOLGUARD_AGENT_ID || !process.env.OPENAI_API_KEY) {
  console.error("Required environment variables:");
  console.error("  TOOLGUARD_API_KEY  - from `npm run seed` output");
  console.error("  TOOLGUARD_ORG_ID   - from `npm run seed` output");
  console.error("  TOOLGUARD_AGENT_ID - from `npm run seed` output");
  console.error("  OPENAI_API_KEY     - your OpenAI API key");
  process.exit(1);
}

// --- ToolGuard Client ---

const tg = new ToolGuard({
  apiKey: TOOLGUARD_API_KEY,
  baseUrl: TOOLGUARD_URL,
  orgId: TOOLGUARD_ORG_ID,
  agentId: TOOLGUARD_AGENT_ID,
});

// --- OpenAI Client ---

const openai = new OpenAI();

// --- Tool Implementations ---

async function postSlackMessage(args: { channel: string; message: string }) {
  console.log(`  [Slack] Posted to #${args.channel}: "${args.message}"`);
  return { ok: true, channel: args.channel, ts: Date.now() };
}

async function sendEmail(args: { to: string; subject: string; body: string }) {
  console.log(`  [Email] Sent to ${args.to}: "${args.subject}"`);
  return { ok: true, messageId: `msg_${Date.now()}` };
}

async function issueRefund(args: { paymentId: string; amountUsd: number; reason: string }) {
  console.log(`  [Stripe] Refunded $${args.amountUsd} for ${args.paymentId}: "${args.reason}"`);
  return { ok: true, refundId: `re_${Date.now()}` };
}

// --- OpenAI Tool Definitions ---

const openaiTools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "post_slack_message",
      description: "Post a message to a Slack channel",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name (e.g., 'support-internal')" },
          message: { type: "string", description: "Message text" },
        },
        required: ["channel", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description: "Send an email to a customer",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject" },
          body: { type: "string", description: "Email body" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "issue_refund",
      description: "Issue a refund for a payment",
      parameters: {
        type: "object",
        properties: {
          paymentId: { type: "string", description: "Stripe payment ID" },
          amountUsd: { type: "number", description: "Refund amount in USD" },
          reason: { type: "string", description: "Reason for refund" },
        },
        required: ["paymentId", "amountUsd", "reason"],
      },
    },
  },
];

// --- ToolGuard Mappings ---

const guardedTools: GuardedToolMap = {
  post_slack_message: {
    toolguardName: "slack.post_message",
    execute: postSlackMessage,
    extractContext: (args: { channel: string }) => ({
      context: { justification: `Post to #${args.channel}` },
      payloadSummary: { channelType: "internal" },
    }),
  },
  send_email: {
    toolguardName: "gmail.send_email",
    execute: sendEmail,
    extractContext: (args: { to: string }) => ({
      context: { justification: "Send customer update", sensitivity: "customer_data" },
      payloadSummary: {
        recipientDomain: args.to.split("@")[1] ?? "unknown",
        containsAttachment: false,
      },
    }),
  },
  issue_refund: {
    toolguardName: "stripe.refund",
    execute: issueRefund,
    extractContext: (args: { amountUsd: number }) => ({
      context: { justification: "Customer refund request" },
      payloadSummary: { amountUsd: args.amountUsd },
    }),
  },
};

// --- Main ---

async function main() {
  console.log("Creating ToolGuard session...\n");

  const session = await tg.createSession({
    environment: "production",
    scopes: ["slack:write", "gmail:send", "stripe:refund"],
    userId: "user_demo",
    metadata: { source: "openai-agent-example" },
  });

  const run = await tg.createRun({
    sessionId: session.id,
    promptSummary: "Handle support ticket with Slack, email, and refund",
  });

  const execute = createGuardedExecutor(tg, session.id, guardedTools, {
    runId: run.id,
    onDenied: (name, reasons) => {
      console.log(`  [ToolGuard] DENIED ${name}: ${reasons.join(", ")}`);
    },
    onApprovalRequired: (name, approvalId) => {
      console.log(`  [ToolGuard] APPROVAL REQUIRED for ${name} (${approvalId})`);
    },
  });

  // Agent conversation
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `You are a support agent. You have three tools available:
1. post_slack_message - Post updates to internal Slack channels
2. send_email - Send emails to customers
3. issue_refund - Issue payment refunds

Handle the following support ticket by:
1. First, post an update to the #support-internal Slack channel
2. Then, send an email to the customer
3. Finally, issue a refund of $1500

If a tool call is denied or requires approval, acknowledge it and move on to the next step.`,
    },
    {
      role: "user",
      content:
        "Ticket #4821: Customer jane@example.com requests a refund of $1500 for payment pi_abc123. They received a damaged product. Please handle this.",
    },
  ];

  console.log("Running agent loop...\n");

  let iterations = 0;
  const maxIterations = 10;

  while (iterations < maxIterations) {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      tools: openaiTools,
    });

    const choice = response.choices[0];
    if (!choice) break;

    const message = choice.message;
    messages.push(message);

    if (!message.tool_calls?.length) {
      console.log(`\nAgent: ${message.content}\n`);
      break;
    }

    for (const toolCall of message.tool_calls) {
      console.log(`Agent calls: ${toolCall.function.name}(${toolCall.function.arguments})`);
      const result = await execute(toolCall);
      console.log(`  Result: ${result}\n`);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    iterations++;
  }

  // Complete the run and show the replay
  await tg.completeRun(run.id, "completed");

  console.log("--- Replay Timeline ---\n");
  const timeline = await tg.replay(run.id);
  for (const event of timeline) {
    console.log(`  ${event.timestamp} | ${event.eventType} | ${event.summary}`);
  }

  console.log(`\nDone. ${timeline.length} events recorded.`);
}

main().catch((err) => {
  console.error("Agent failed:", err);
  process.exit(1);
});

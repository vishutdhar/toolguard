export const demoAgent = {
  name: "support-agent",
  description: "AI support agent with Slack, Gmail, Stripe, and export tools.",
  environment: "production",
  defaultScopes: ["slack:write", "gmail:send", "stripe:refund", "customer:export"],
} as const;

export const demoToolCatalog = [
  {
    name: "slack.post_message",
    action: "post",
    resource: "internal_channel",
    description: "Post an internal Slack message",
    riskLevel: "low",
  },
  {
    name: "gmail.send_email",
    action: "send",
    resource: "external_email",
    description: "Send an external Gmail message",
    riskLevel: "high",
  },
  {
    name: "stripe.refund",
    action: "refund",
    resource: "payment",
    description: "Issue a Stripe refund",
    riskLevel: "high",
  },
  {
    name: "shell.exec",
    action: "execute",
    resource: "shell",
    description: "Execute a shell command",
    riskLevel: "high",
  },
  {
    name: "customer.export_csv",
    action: "export",
    resource: "customer_data",
    description: "Export customer data",
    riskLevel: "high",
  },
] as const;

export const demoPolicyCatalog = [
  {
    name: "External Gmail Requires Approval",
    description: "Production external email requires human approval.",
    rulesJson: [
      {
        if: {
          "tool.name": "gmail.send_email",
          environment: "production",
          "tool.resource": "external_email",
        },
        then: {
          decision: "require_approval",
          reasonCodes: ["HIGH_RISK_EXTERNAL_ACTION"],
        },
      },
    ],
  },
  {
    name: "Large Stripe Refunds Denied",
    description: "Refunds above the threshold are denied.",
    rulesJson: [
      {
        if: {
          "tool.name": "stripe.refund",
          environment: "production",
          "payloadSummary.amountUsd": {
            gt: 1000,
          },
        },
        then: {
          decision: "deny",
          reasonCodes: ["REFUND_THRESHOLD_EXCEEDED"],
        },
      },
    ],
  },
  {
    name: "Slack Internal Allowed",
    description: "Internal Slack posts are allowed.",
    rulesJson: [
      {
        if: {
          "tool.name": "slack.post_message",
          "payloadSummary.channelType": "internal",
        },
        then: {
          decision: "allow",
          reasonCodes: ["INTERNAL_COLLABORATION"],
        },
      },
    ],
  },
  {
    name: "Shell Denied In Production",
    description: "Production shell execution is denied.",
    rulesJson: [
      {
        if: {
          "tool.resource": "shell",
          environment: "production",
        },
        then: {
          decision: "deny",
          reasonCodes: ["SHELL_EXECUTION_BLOCKED"],
        },
      },
    ],
  },
  {
    name: "Customer Data Export Requires Approval",
    description: "Sensitive customer data exports require approval.",
    rulesJson: [
      {
        if: {
          "tool.action": "export",
          "context.sensitivity": "customer_data",
        },
        then: {
          decision: "require_approval",
          reasonCodes: ["CUSTOMER_DATA_EXPORT"],
        },
      },
    ],
  },
] as const;

export const demoToolNames = {
  slack: "slack.post_message",
  gmail: "gmail.send_email",
  stripeRefund: "stripe.refund",
  shell: "shell.exec",
  exportData: "customer.export_csv",
} as const;

import type { AuthService } from "../services/auth-service";
import type { DataStore } from "../domain/store";
import {
  demoAgent,
  demoPolicyCatalog,
  demoToolCatalog,
  demoToolNames,
} from "./demo-catalog";

export interface DemoSeedResult {
  organizationId: string;
  rawApiKey: string;
  agentId: string;
  toolNames: {
    slack: string;
    gmail: string;
    stripeRefund: string;
    shell: string;
    exportData: string;
  };
}

export async function seedDemoData(store: DataStore, authService: AuthService): Promise<DemoSeedResult> {
  const organization = await store.createOrganization({ name: "ToolGuard Demo Org" });
  const { rawKey } = await authService.createApiKey(organization.id, "Demo key");
  const agent = await store.createAgent({
    organizationId: organization.id,
    name: demoAgent.name,
    description: demoAgent.description,
    environment: demoAgent.environment,
    defaultScopes: [...demoAgent.defaultScopes],
  });

  await Promise.all(
    demoToolCatalog.map((tool) =>
      store.createTool({
        organizationId: organization.id,
        name: tool.name,
        action: tool.action,
        resource: tool.resource,
        description: tool.description,
        riskLevel: tool.riskLevel,
        estimatedCostUsd: tool.estimatedCostUsd,
      }),
    ),
  );

  for (const policyDefinition of demoPolicyCatalog) {
    const policy = await store.createPolicy({
      organizationId: organization.id,
      name: policyDefinition.name,
      description: policyDefinition.description,
      isActive: true,
    });

    await store.createPolicyVersion({
      policyId: policy.id,
      versionNumber: 1,
      rulesJson: policyDefinition.rulesJson.map((rule) => ({
        if: { ...rule.if },
        then: {
          decision: rule.then.decision,
          reasonCodes: rule.then.reasonCodes ? [...rule.then.reasonCodes] : undefined,
        },
      })),
    });
  }

  return {
    organizationId: organization.id,
    rawApiKey: rawKey,
    agentId: agent.id,
    toolNames: demoToolNames,
  };
}

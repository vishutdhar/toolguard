import { hashApiKey, generateApiKeyValue, getApiKeyPrefix, parseBearerToken } from "../lib/api-key";
import { AppError } from "../lib/errors";
import type { DataStore } from "../domain/store";
import type { ApiKeyRecord, Organization } from "../domain/types";

export interface AuthContext {
  organization: Organization;
  apiKey: ApiKeyRecord;
}

export class AuthService {
  constructor(private readonly store: DataStore) {}

  async createApiKey(organizationId: string, name: string): Promise<{ apiKey: ApiKeyRecord; rawKey: string }> {
    const rawKey = generateApiKeyValue();
    const apiKey = await this.store.createApiKey({
      organizationId,
      name,
      keyHash: hashApiKey(rawKey),
      keyPrefix: getApiKeyPrefix(rawKey),
    });

    return { apiKey, rawKey };
  }

  async authenticate(authorizationHeader: string | undefined): Promise<AuthContext> {
    const token = parseBearerToken(authorizationHeader);
    if (!token) {
      throw new AppError("Missing or invalid API key", 401, "UNAUTHORIZED");
    }

    const apiKey = await this.store.findApiKeyByHash(hashApiKey(token));
    if (!apiKey || apiKey.revokedAt) {
      throw new AppError("Invalid API key", 401, "UNAUTHORIZED");
    }

    const organization = await this.store.getOrganization(apiKey.organizationId);
    if (!organization) {
      throw new AppError("Organization not found for API key", 401, "UNAUTHORIZED");
    }

    await this.store.updateApiKeyLastUsed(apiKey.id, new Date());

    return { organization, apiKey };
  }
}

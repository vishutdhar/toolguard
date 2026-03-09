import { createHash, randomBytes } from "node:crypto";

export function generateApiKeyValue(): string {
  return `tg_${randomBytes(24).toString("base64url")}`;
}

export function hashApiKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function getApiKeyPrefix(value: string): string {
  return value.slice(0, 12);
}

export function parseBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token.trim();
}

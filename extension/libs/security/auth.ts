import { ToolErrorException, type ClientIdentity, type ClientTransport } from "../tool-contracts/index.js";

export function randomToken(bytes = 32): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return [...array].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison to avoid token timing leaks. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface RegisteredClient {
  client: ClientIdentity;
  createdAt: number;
  revoked: boolean;
  tokenHash: string;
}

export interface RegisterClientInput {
  name: string;
  transport: ClientTransport;
  version?: string;
  id?: string;
}

/**
 * Registry of authenticated remote clients. Only hashed tokens are retained;
 * the plaintext token is returned exactly once at registration.
 */
export class ClientRegistry {
  private readonly byId = new Map<string, RegisteredClient>();
  private readonly byTokenHash = new Map<string, RegisteredClient>();

  async register(input: RegisterClientInput): Promise<{ client: ClientIdentity; token: string }> {
    const id = input.id ?? `client_${randomToken(8)}`;
    if (this.byId.has(id)) throw new ToolErrorException("CONFLICT", `Client "${id}" already exists`);
    const token = randomToken(32);
    const tokenHash = await sha256Hex(token);
    const client: ClientIdentity = { id, name: input.name, transport: input.transport, version: input.version };
    const record: RegisteredClient = { client, createdAt: Date.now(), revoked: false, tokenHash };
    this.byId.set(id, record);
    this.byTokenHash.set(tokenHash, record);
    return { client, token };
  }

  async authenticate(token: string): Promise<ClientIdentity> {
    const tokenHash = await sha256Hex(token);
    const record = this.byTokenHash.get(tokenHash);
    if (!record) throw new ToolErrorException("UNAUTHORIZED", "Invalid client token");
    if (record.revoked) throw new ToolErrorException("UNAUTHORIZED", "Client has been revoked");
    return record.client;
  }

  revoke(id: string): boolean {
    const record = this.byId.get(id);
    if (!record) return false;
    record.revoked = true;
    this.byTokenHash.delete(record.tokenHash);
    return true;
  }

  list(): ClientIdentity[] {
    return [...this.byId.values()].filter((r) => !r.revoked).map((r) => r.client);
  }
}

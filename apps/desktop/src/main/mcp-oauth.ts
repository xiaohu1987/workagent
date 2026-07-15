import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { safeStorage, shell } from "electron";
import type { McpServerConfig } from "@shared-types";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

type StoredCredentials = Record<string, string>;

/** Stores encrypted OAuth material outside config.toml. Never falls back to plaintext. */
export class McpCredentialStore {
  public constructor(private readonly filePath: string) {}

  public async read<T>(key: string): Promise<T | undefined> {
    const encrypted = (await this.readAll())[key];
    if (!encrypted) return undefined;
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Operating-system credential encryption is unavailable.");
    return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, "base64"))) as T;
  }

  public async write(key: string, value: unknown): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Operating-system credential encryption is unavailable.");
    const values = await this.readAll();
    values[key] = safeStorage.encryptString(JSON.stringify(value)).toString("base64");
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(values), "utf8");
  }

  public async remove(key: string): Promise<void> {
    const values = await this.readAll();
    if (!(key in values)) return;
    delete values[key];
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(values), "utf8");
  }

  private async readAll(): Promise<StoredCredentials> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as StoredCredentials : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
}

export class McpOAuthService {
  public constructor(private readonly credentials: McpCredentialStore) {}

  public async createProvider(config: McpServerConfig): Promise<OAuthClientProvider | undefined> {
    if (config.auth?.mode !== "oauth") return undefined;
    if (!config.auth.oauthClientId) throw new Error(`MCP server ${config.id} requires an OAuth client id.`);
    return this.createProviderForCallback(config, "http://127.0.0.1/oauth-login-required", "", false);
  }

  public async login(config: McpServerConfig): Promise<void> {
    if (config.auth?.mode !== "oauth" || !config.url) {
      throw new Error("OAuth login requires an HTTP MCP server configured for OAuth.");
    }
    if (!config.auth.oauthClientId) {
      throw new Error("OAuth login requires a pre-registered OAuth client id.");
    }

    const state = randomBytes(24).toString("base64url");
    const callback = await startCallbackServer(state);
    try {
      const provider = this.createProviderForCallback(config, callback.redirectUrl, state, true);
      const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
      const result = await auth(provider, {
        serverUrl: config.url,
        scope: config.auth.oauthScopes?.join(" ") || undefined,
        resourceMetadataUrl: config.auth.oauthResource ? new URL(config.auth.oauthResource) : undefined
      });
      if (result === "AUTHORIZED") return;
      const code = await callback.waitForCode();
      await auth(provider, {
        serverUrl: config.url,
        authorizationCode: code,
        scope: config.auth.oauthScopes?.join(" ") || undefined,
        resourceMetadataUrl: config.auth.oauthResource ? new URL(config.auth.oauthResource) : undefined
      });
      await this.credentials.remove(verifierKey(config.id));
    } finally {
      await callback.close();
    }
  }

  public async logout(serverId: string): Promise<void> {
    await Promise.all([
      this.credentials.remove(tokensKey(serverId)),
      this.credentials.remove(verifierKey(serverId))
    ]);
  }

  public async status(config: McpServerConfig): Promise<"not_configured" | "signed_out" | "signed_in"> {
    if (config.auth?.mode !== "oauth") return "not_configured";
    return (await this.credentials.read(tokensKey(config.id))) ? "signed_in" : "signed_out";
  }

  private createProviderForCallback(
    config: McpServerConfig,
    redirectUrl: string,
    state: string,
    interactive: boolean
  ): OAuthClientProvider {
    const clientId = config.auth?.oauthClientId!;
    const metadata = {
      client_id: clientId,
      redirect_uris: [redirectUrl],
      token_endpoint_auth_method: "none"
    };
    return {
      get redirectUrl() { return redirectUrl; },
      get clientMetadata() { return metadata; },
      state: () => state,
      clientInformation: () => metadata,
      tokens: () => this.credentials.read(tokensKey(config.id)),
      saveTokens: (tokens) => this.credentials.write(tokensKey(config.id), tokens),
      redirectToAuthorization: async (url) => {
        if (!interactive) throw new Error(`OAuth login is required for MCP server ${config.id}.`);
        await shell.openExternal(url.toString());
      },
      saveCodeVerifier: (verifier) => this.credentials.write(verifierKey(config.id), verifier),
      codeVerifier: async () => {
        const verifier = await this.credentials.read<string>(verifierKey(config.id));
        if (!verifier) throw new Error("OAuth authorization session expired. Please sign in again.");
        return verifier;
      }
    } as OAuthClientProvider;
  }
}

function tokensKey(serverId: string): string { return `mcp.oauth.${serverId}.tokens`; }
function verifierKey(serverId: string): string { return `mcp.oauth.${serverId}.verifier`; }

async function startCallbackServer(expectedState: string): Promise<{
  redirectUrl: string;
  waitForCode: () => Promise<string>;
  close: () => Promise<void>;
}> {
  let settle: ((value: string) => void) | undefined;
  let fail: ((reason: Error) => void) | undefined;
  const code = new Promise<string>((resolve, reject) => { settle = resolve; fail = reject; });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const receivedState = url.searchParams.get("state");
    const authorizationCode = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error) {
      fail?.(new Error(`OAuth authorization failed: ${error}`));
    } else if (!authorizationCode || receivedState !== expectedState) {
      fail?.(new Error("OAuth callback state validation failed."));
    } else {
      settle?.(authorizationCode);
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<p>Authentication completed. You can return to CodeXH.</p>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start OAuth callback server.");
  return {
    redirectUrl: `http://127.0.0.1:${address.port}/oauth/callback`,
    waitForCode: () => Promise.race([
      code,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("OAuth login timed out.")), 5 * 60_000))
    ]),
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ConfidentialClientApplication } from "@azure/msal-node";
import session, { type SessionData } from "express-session";
import type { Request, Response, NextFunction } from "express";
import type { AzureServices } from "./azure.js";
import type { Database } from "./db.js";
import type { Identity } from "./domain.js";
import { powerBiScopes } from "./config.js";
import { AppError, requireCondition } from "./errors.js";

declare module "express-session" {
  interface SessionData {
    identity?: Identity;
    msalCache?: string;
    csrf?: string;
    login?: { state: string; nonce: string; verifier: string; startedAt: number };
  }
}
export class EncryptedSqlSessionStore extends session.Store {
  constructor(private db: Database, private key: () => Promise<string>) { super(); }
  private async cipherKey() { return createHash("sha256").update(await this.key()).digest(); }
  override get(id: string, callback: (error?: unknown, session?: SessionData | null) => void) {
    void (async () => {
      const [row] = await this.db.read<{ Data: string }>("SELECT Data FROM app.Sessions WHERE Id=@id AND ExpiresAt>SYSUTCDATETIME()", { id });
      if (!row) return null;
      const [iv, tag, body] = row.Data.split(".");
      if (!iv || !tag || !body) return null;
      const decipher = createDecipheriv("aes-256-gcm", await this.cipherKey(), Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString()) as SessionData;
    })().then(value => callback(null, value)).catch(error => callback(error instanceof AppError ? error : new Error("Session storage unavailable")));
  }
  override set(id: string, data: SessionData, callback?: (error?: unknown) => void) {
    void (async () => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", await this.cipherKey(), iv);
      const body = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
      const value = [iv, cipher.getAuthTag(), body].map(v => v.toString("base64")).join(".");
      const expires = data.cookie.expires ? new Date(data.cookie.expires) : new Date(Date.now() + 8 * 3_600_000);
      await this.db.query(`MERGE app.Sessions WITH (HOLDLOCK) AS target USING(SELECT @id Id) source ON target.Id=source.Id
        WHEN MATCHED THEN UPDATE SET Data=@data,ExpiresAt=@expires
        WHEN NOT MATCHED THEN INSERT(Id,Data,ExpiresAt) VALUES(@id,@data,@expires);`, { id, data: value, expires });
    })().then(() => callback?.()).catch(error => callback?.(error instanceof AppError ? error : new Error("Session storage unavailable")));
  }
  override destroy(id: string, callback?: (error?: unknown) => void) {
    void this.db.query("DELETE app.Sessions WHERE Id=@id", { id })
      .then(() => callback?.()).catch(() => callback?.(new Error("Session storage unavailable")));
  }
}

export const csrfValue = () => randomBytes(32).toString("base64url");
export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const expected = req.session.csrf;
  const provided = req.get("X-CSRF-Token") ?? "";
  if (!expected || expected.length !== provided.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(provided)))
    return next(new AppError(403, "CsrfFailed", "Refresh the page and retry the request."));
  next();
}
export const saveSession = (req: Request) => new Promise<void>((resolve, reject) => req.session.save(e => e ? reject(e) : resolve()));

export class AuthService {
  constructor(private azure: AzureServices) {}
  private async client(cache?: string) {
    const app = new ConfidentialClientApplication({
      auth: {
        clientId: this.azure.config.WebClientId,
        clientSecret: await this.azure.secret(this.azure.config.WebClientSecretName),
        authority: `https://login.microsoftonline.com/${this.azure.config.DirectoryTenantId}`,
      },
    });
    if (cache) app.getTokenCache().deserialize(cache);
    return app;
  }
  async login(req: Request) {
    const verifier = randomBytes(32).toString("base64url");
    req.session.login = { verifier, state: csrfValue(), nonce: csrfValue(), startedAt: Date.now() };
    const client = await this.client();
    const url = await client.getAuthCodeUrl({
      scopes: powerBiScopes,
      redirectUri: `${this.azure.config.PublicOrigin}/auth/callback`,
      state: req.session.login.state, nonce: req.session.login.nonce,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"), codeChallengeMethod: "S256",
    });
    await saveSession(req);
    return url;
  }
  async callback(req: Request) {
    const login = req.session.login;
    requireCondition(login && req.query.state === login.state && typeof req.query.code === "string" &&
      Date.now() - login.startedAt < 600_000, 400, "InvalidLogin", "The sign-in request expired or its state is invalid.");
    const client = await this.client();
    const result = await client.acquireTokenByCode({
      code: req.query.code, scopes: powerBiScopes, codeVerifier: login.verifier,
      redirectUri: `${this.azure.config.PublicOrigin}/auth/callback`,
    });
    const claims = result.idTokenClaims as Record<string, unknown>;
    requireCondition(claims.tid === this.azure.config.DirectoryTenantId && claims.nonce === login.nonce &&
      typeof claims.oid === "string", 403, "InvalidIdentity", "The identity directory or login nonce is invalid.");
    const identity: Identity = {
      objectId: String(claims.oid), directoryId: String(claims.tid),
      name: String(claims.name ?? "User"), username: String(claims.preferred_username ?? ""),
    };
    await new Promise<void>((resolve, reject) => req.session.regenerate(e => e ? reject(e) : resolve()));
    req.session.identity = identity;
    req.session.msalCache = client.getTokenCache().serialize();
    req.session.csrf = csrfValue();
    await saveSession(req);
  }
  async operatorToken(req: Request) {
    requireCondition(req.session.identity && req.session.msalCache, 401, "SignInRequired", "Sign in again to perform this management operation.");
    const client = await this.client(req.session.msalCache);
    const [account] = await client.getTokenCache().getAllAccounts();
    requireCondition(account, 401, "SignInRequired", "Sign in again to perform this management operation.");
    try {
      const token = await client.acquireTokenSilent({ account, scopes: powerBiScopes });
      req.session.msalCache = client.getTokenCache().serialize();
      await saveSession(req);
      return token.accessToken;
    } catch {
      throw new AppError(401, "ConsentRequired", "Sign in again and grant the required Power BI management permissions.");
    }
  }
}

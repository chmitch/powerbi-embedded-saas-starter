import { existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AppError } from "./errors.js";

const nameSchema = z.string().regex(/^[a-zA-Z0-9-]{1,127}$/);
const storeSchema = z.object({
  version: z.literal(1),
  secrets: z.record(nameSchema, z.object({ value: z.string().min(1), expiresOn: z.iso.datetime().optional() })),
});
const repositoryRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."));
const withinRepository = (file: string) => {
  const relative = path.relative(repositoryRoot, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

export class LocalSecretStore {
  private readonly file: string;
  constructor(file: string, production: boolean) {
    if (production || process.env.WEBSITE_INSTANCE_ID)
      throw new AppError(503, "LocalSecretsForbidden", "Local secret files are not allowed in production or App Service.");
    if (!path.isAbsolute(file) || withinRepository(path.resolve(file)))
      throw new AppError(503, "LocalSecretsForbidden", "Local secrets must be outside the repository.");
    try {
      this.file = existsSync(file) ? realpathSync(file) : path.join(realpathSync(path.dirname(file)), path.basename(file));
      if (withinRepository(this.file)) throw new Error("Repository target");
    } catch {
      throw new AppError(503, "LocalSecretsForbidden", "The local secret path must resolve outside the repository in an existing private directory.");
    }
  }
  private read() {
    try { return storeSchema.parse(JSON.parse(readFileSync(this.file, "utf8").replace(/^\uFEFF/, ""))); }
    catch { throw new AppError(503, "LocalSecretsUnavailable", "The local secret file is missing, invalid, or inaccessible. Run local initialization."); }
  }
  async getSecret(name: string): Promise<{ value?: string }> {
    const store = this.read();
    const entry = Object.hasOwn(store.secrets, name) ? store.secrets[name] : undefined;
    if (!entry) {
      const error = new AppError(503, "LocalSecretMissing", "A required local credential has not been initialized.");
      Object.assign(error, { statusCode: 404 });
      throw error;
    }
    if (entry.expiresOn && Date.parse(entry.expiresOn) <= Date.now())
      throw new AppError(503, "LocalSecretExpired", "A local credential has expired. Rotate it explicitly.");
    return { value: entry.value };
  }
  async setSecret(name: string, value: string, options?: { expiresOn?: Date }): Promise<{ value?: string }> {
    if (!nameSchema.safeParse(name).success || !value)
      throw new AppError(503, "InvalidLocalSecret", "The local credential name or value is invalid.");
    const store = this.read();
    store.secrets[name] = { value, ...(options?.expiresOn ? { expiresOn: options.expiresOn.toISOString() } : {}) };
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(store), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.file);
    } catch {
      throw new AppError(503, "LocalSecretsUnavailable", "The local credential could not be saved. Check the private directory permissions.");
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return { value };
  }
}

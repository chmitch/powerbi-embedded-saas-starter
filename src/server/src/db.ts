import sql from "mssql";
import type { AzureServices } from "./azure.js";
import { AppError } from "./errors.js";
import { capacityDemand, CapacityRecovery, sqlCapacityUnavailable, waitForCapacityData } from "./capacity-recovery.js";

export type Params = Record<string, string | number | boolean | Date | null | undefined>;
export interface Executor {
  query<T = Record<string, unknown>>(text: string, params?: Params): Promise<T[]>;
}
export class Database implements Executor {
  private pool?: sql.ConnectionPool;
  private connecting?: Promise<sql.ConnectionPool>;
  private expires = 0;
  private recovery: CapacityRecovery;
  constructor(private azure: AzureServices, recovery?: CapacityRecovery) { this.recovery = recovery ?? new CapacityRecovery(azure); }
  private async connect(): Promise<sql.ConnectionPool> {
    if (!this.azure.config.SqlServer || !this.azure.config.SqlDatabase)
      throw new AppError(503, "NotConfigured", "Run the local provisioning script and configure the Fabric SQL database first.");
    if (this.pool?.connected && Date.now() < this.expires) return this.pool;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const token = await this.azure.runtime.getToken("https://database.windows.net/.default");
      if (!token) throw new AppError(503, "SqlIdentityUnavailable", "Could not authenticate to the SQL database.");
      const pool = new sql.ConnectionPool({
        server: this.azure.config.SqlServer,
        database: this.azure.config.SqlDatabase,
        authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
        options: { encrypt: true, trustServerCertificate: false },
        pool: { max: 10, idleTimeoutMillis: 30_000 },
        requestTimeout: 45_000,
      });
      pool.on("error", () => { this.expires = 0; });
      try { await pool.connect(); }
      catch (error) { await pool.close().catch(() => undefined); throw error; }
      const old = this.pool;
      this.pool = pool;
      this.expires = token.expiresOnTimestamp - 300_000;
      if (old) setTimeout(() => { void old.close(); }, 120_000).unref();
      return pool;
    })();
    try { return await this.connecting; } finally { this.connecting = undefined; }
  }
  async query<T = Record<string, unknown>>(text: string, params: Params = {}): Promise<T[]> {
    return execute<T>((await this.availablePool()).request(), text, params);
  }
  async read<T = Record<string, unknown>>(text: string, params: Params = {}): Promise<T[]> {
    try { return await this.query<T>(text, params); }
    catch (error) {
      if (!await this.recover(error)) throw error;
      return waitForCapacityData(() => this.query<T>(text, params), sqlCapacityUnavailable);
    }
  }
  private async recover(error: unknown) {
    if (!sqlCapacityUnavailable(error) || !this.azure.config.ManagementCapacityResourceId) return false;
    const resumed = await this.recovery.resume(this.azure.config.ManagementCapacityResourceId);
    if (!resumed && this.azure.config.AutoResumeCapacities && capacityDemand.getStore()) {
      throw new AppError(503, "ManagementDatabaseUnavailable",
        "The management database is unavailable and its capacity was not resumed. It may already be running. Check Fabric SQL database and capacity status.");
    }
    if (resumed) this.expires = 0;
    return resumed;
  }
  private async availablePool() {
    try { return await this.connect(); }
    catch (error) {
      if (!await this.recover(error)) throw error;
      return waitForCapacityData(() => this.connect(), sqlCapacityUnavailable);
    }
  }
  async transaction<T>(work: (executor: Executor) => Promise<T>): Promise<T> {
    const transaction = new sql.Transaction(await this.availablePool());
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const result = await work({ query: <R>(text: string, params: Params = {}) => execute<R>(transaction.request(), text, params) });
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }
  async close() { await this.pool?.close(); }
}
async function execute<T>(request: sql.Request, text: string, params: Params): Promise<T[]> {
  for (const [name, value] of Object.entries(params)) {
    if (value === null || value === undefined) request.input(name, sql.NVarChar, null);
    else if (typeof value === "boolean") request.input(name, sql.Bit, value);
    else if (typeof value === "number") request.input(name, sql.Int, value);
    else if (value instanceof Date) request.input(name, sql.DateTime2, value);
    else request.input(name, sql.NVarChar(sql.MAX), value);
  }
  return (await request.query<T>(text)).recordset;
}

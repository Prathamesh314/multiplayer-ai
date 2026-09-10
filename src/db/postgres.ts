import {
  Kysely,
  PostgresDialect,
  sql,
  type Transaction,
} from 'kysely';
import { Pool, type PoolConfig } from 'pg';
import type { DB } from '@/src/types/db-types';
import { Env } from '@/src/lib/env';
import { log } from '@/src/utils/logger';

// Optimized pool configuration using DATABASE_URL
const dbConfig: PoolConfig = {
  connectionString: Env.DATABASE_URL || process.env.DATABASE_URL,
  // Connection pool settings - CRITICAL for performance
  max: 50,                      // Maximum connections in pool (increase for load)
  min: 5,                       // Minimum connections to keep warm
  idleTimeoutMillis: 30000,     // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Fail fast if can't connect in 5s
  allowExitOnIdle: false,       // Keep pool alive
};

log.info('Postgres DB Config initialized', { maxPool: dbConfig.max });

export const tables = {};

export class Postgres {
  private static instance: Postgres;
  private db: Kysely<DB>;
  private pool: Pool;
  private isConnected = false;
  private isInitialized = false;

  private constructor() {
    this.pool = new Pool(dbConfig);

    const dialect = new PostgresDialect({ pool: this.pool });

    this.db = new Kysely<DB>({ dialect });

    log.info('Kysely database instance created');
  }

  public static getInstance(): Postgres {
    if (!Postgres.instance) {
      Postgres.instance = new Postgres();
    }
    return Postgres.instance;
  }

  public getKyselyInstance(): Kysely<DB> {
    return this.db;
  }

  public async connectDb(): Promise<void> {
    if (this.isConnected) {
      log.debug('Database already connected');
      return;
    }

    try {
      log.info('Connecting to PostgreSQL database...');

      // Ensure required extensions (uuid via pgcrypto)
      await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(this.db);

      const result = await sql`SELECT NOW()`.execute(this.db);
      this.isConnected = true;

      log.info('Database connected successfully', {
        timestamp: (result.rows[0] as any).now,
      });
    } catch (error) {
      log.error('Failed to connect to database', error);
      throw error;
    }
  }

  public async init(): Promise<void> {
    if (this.isInitialized) {
      log.debug('Database already initialized');
      return;
    }

    log.info('Initializing database schema...');
    try {
      // Add your schema initialization queries here
      await sql`
        
      `.execute(this.db);

      this.isInitialized = true;
      log.info('Database schema initialized successfully');
    } catch (e) {
      log.error('Error initializing database tables', e);
      throw e;
    }
  }

  public async transaction<T>(
    callback: (trx: Transaction<DB>) => Promise<T>
  ): Promise<T> {
    return this.db.transaction().execute(callback);
  }

  public connection(): Kysely<DB> {
    return this.getKyselyInstance();
  }
}

const getPostgresConn = async (): Promise<Postgres> => {
  const postgres = Postgres.getInstance();
  await postgres.connectDb();
  await postgres.init();
  return postgres;
};

export default getPostgresConn;
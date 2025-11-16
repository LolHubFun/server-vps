import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { appConfig } from './config.js';

export type DbValue = string | number | boolean | bigint | Buffer | Date | null;
export type DbClient = (strings: TemplateStringsArray, ...values: DbValue[]) => Promise<any[]>;

export const pool = new Pool({
  connectionString: appConfig.DATABASE_URL,
  max: Number(process.env.DB_POOL_SIZE || 10),
});

pool.on('error', (err) => {
  console.error('[DB-POOL] Unexpected error on idle client', err);
});

export function createDbClient(dbPool: Pool): DbClient {
  return async (strings: TemplateStringsArray, ...values: DbValue[]): Promise<any[]> => {
    const textParts: string[] = [];
    const params: DbValue[] = [];

    strings.forEach((part, index) => {
      textParts.push(part);
      if (index < values.length) {
        params.push(values[index]);
        textParts.push(`$${params.length}`);
      }
    });

    const queryText = textParts.join('');
    let result: QueryResult;
    try {
      result = await dbPool.query(queryText, params);
    } catch (error) {
      console.error('[DB-QUERY-ERROR]', queryText, params, error);
      throw error;
    }
    return result.rows;
  };
}

export const dbClient = createDbClient(pool);

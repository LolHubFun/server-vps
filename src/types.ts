// src/types.ts - TEMİZLENMİŞ HALİ

import { Hono } from 'hono';
import type { DbClient } from './db.js';

// Cloudflare'e özel olmayan genel ortam değişkenleri
export interface Env {
    DATABASE_URL: string;
    INFURA_AMOY_RPC_URL: string;
    INFURA_PROJECT_SECRET?: string;
    FACTORY_CONTRACT_ADDRESS: string;
    WORKER_WALLET_PRIVATE_KEY: string;
    REPLICATE_API_TOKEN: string;
    ARWEAVE_KEYFILE_JSON: string;
    PLATFORM_GENERAL_FEE_WALLET_ADDRESS: string;
    ETHERSCAN_API_KEY: string;
    TURNSTILE_SECRET?: string;
    REDIS_URL: string;
}

export type AppHono = Hono<{
    Variables: {
        db: DbClient;
    };
}>;

// Bu tipler genel olduğu için kalabilir
export interface EventWithMetadata {
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  eventData: any;
  timestamp: Date;
  contractAddress: string;
}

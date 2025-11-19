// src/types.ts - NİHAİ HALİ
import { Hono } from 'hono';
import { Pool } from 'pg';
import type { CacheService } from './cache.service.js';

// .env dosyasında olması gereken tüm değişkenlerin tipleri
export interface Env {
    DATABASE_URL: string;
    REDIS_URL: string;
    INFURA_AMOY_RPC_URL: string;
    INFURA_MAINNET_RPC_URL?: string;
    BSC_RPC_URL?: string;
    AVAX_RPC_URL?: string;
    POLYGON_RPC_URL?: string;
    BASE_RPC_URL?: string;
    ARBITRUM_RPC_URL?: string;
    OPTIMISM_RPC_URL?: string;
    INFURA_PROJECT_ID?: string;
    INFURA_PROJECT_SECRET?: string;
    FACTORY_CONTRACT_ADDRESS: string;
    WORKER_WALLET_PRIVATE_KEY: string;
    REPLICATE_API_TOKEN: string;
    ARWEAVE_KEYFILE_JSON: string;
    PLATFORM_GENERAL_FEE_WALLET_ADDRESS: string;
    ETHERSCAN_API_KEY: string;
    TURNSTILE_SECRET?: string;
    PUBLIC_HOSTNAME: string;
    ADMIN_SECRET_KEY?: string;
    ADMIN_EMERGENCY_WEBHOOK?: string;
    JWT_SECRET: string;
    [key: string]: string | undefined;
}

export interface EventWithMetadata {
    blockNumber: bigint | number;
    transactionHash: string;
    logIndex: number;
    contractAddress: string;
    eventData: any;
}

// Hono context tipimiz
export type AppHono = Hono<{
    Variables: {
        db: Pool;
        cache: CacheService;
        env: Env;
    };
}>;

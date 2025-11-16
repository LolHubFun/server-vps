// src/types.ts - YENİ VE TEMİZ HALİ
import { Hono } from 'hono';
import { Pool } from 'pg'; // NeonQueryFunction yerine Pool'u import et

// Sunucudaki .env dosyasında bulunması gereken tüm değişkenler
export interface Env {
    DATABASE_URL: string;
    REDIS_URL: string;
    
    INFURA_AMOY_RPC_URL: string;
    INFURA_PROJECT_SECRET?: string;
    INFURA_MAINNET_RPC_URL?: string; // Diğer chain'ler için eklendi
    BSC_RPC_URL?: string;
    POLYGON_RPC_URL?: string;
    AVAX_RPC_URL?: string;
    BASE_RPC_URL?: string;
    ARBITRUM_RPC_URL?: string;
    OPTIMISM_RPC_URL?: string;

    FACTORY_CONTRACT_ADDRESS: string;
    WORKER_WALLET_PRIVATE_KEY: string; // Bu isim kalabilir, backend cüzdanı olduğunu biliyoruz
    
    REPLICATE_API_TOKEN: string;
    ARWEAVE_KEYFILE_JSON: string;
    
    PLATFORM_GENERAL_FEE_WALLET_ADDRESS: string;
    ETHERSCAN_API_KEY: string;
    TURNSTILE_SECRET?: string;
    PUBLIC_HOSTNAME: string; // Logo URL'leri için eklendi
}

// Hono context'ini güncelle
export type AppHono = Hono<{
    Bindings: {}; // Bindings artık kullanılmıyor, boş kalabilir
    Variables: {
        db: Pool; // db değişkeninin tipi artık Pool
    };
}>;

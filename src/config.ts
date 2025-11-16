import 'dotenv/config';
import path from 'node:path';

const requiredKeys = [
  'DATABASE_URL',
  'INFURA_AMOY_RPC_URL',
  'FACTORY_CONTRACT_ADDRESS',
  'WORKER_WALLET_PRIVATE_KEY',
  'REPLICATE_API_TOKEN',
  'ARWEAVE_KEYFILE_JSON',
  'PLATFORM_GENERAL_FEE_WALLET_ADDRESS',
  'ETHERSCAN_API_KEY',
  'REDIS_URL',
  'PUBLIC_HOSTNAME'
] as const;

function getEnv(key: string, optional = false): string {
  const value = process.env[key];
  if (!value || value.length === 0) {
    if (optional) {
      return '';
    }
    throw new Error(`Environment variable ${key} is required but was not provided.`);
  }
  return value;
}

export const appConfig = {
  DATABASE_URL: getEnv('DATABASE_URL'),
  INFURA_AMOY_RPC_URL: getEnv('INFURA_AMOY_RPC_URL'),
  FACTORY_CONTRACT_ADDRESS: getEnv('FACTORY_CONTRACT_ADDRESS'),
  WORKER_WALLET_PRIVATE_KEY: getEnv('WORKER_WALLET_PRIVATE_KEY'),
  REPLICATE_API_TOKEN: getEnv('REPLICATE_API_TOKEN'),
  ARWEAVE_KEYFILE_JSON: getEnv('ARWEAVE_KEYFILE_JSON'),
  PLATFORM_GENERAL_FEE_WALLET_ADDRESS: getEnv('PLATFORM_GENERAL_FEE_WALLET_ADDRESS'),
  ETHERSCAN_API_KEY: getEnv('ETHERSCAN_API_KEY'),
  REDIS_URL: getEnv('REDIS_URL'),
  PUBLIC_HOSTNAME: getEnv('PUBLIC_HOSTNAME'),
  UPLOADS_DIR: path.resolve(process.cwd(), process.env.UPLOADS_DIR || 'uploads/logos'),
  TURNSTILE_SECRET: process.env.TURNSTILE_SECRET || '',
  ADMIN_EMERGENCY_WEBHOOK: process.env.ADMIN_EMERGENCY_WEBHOOK || '',
  INFURA_PROJECT_SECRET: process.env.INFURA_PROJECT_SECRET || '',
  OPTIONAL_RPC_URLS: {
    POLYGON_RPC_URL: process.env.POLYGON_RPC_URL || '',
    BSC_RPC_URL: process.env.BSC_RPC_URL || '',
    AVAX_RPC_URL: process.env.AVAX_RPC_URL || '',
    BASE_RPC_URL: process.env.BASE_RPC_URL || '',
    ARBITRUM_RPC_URL: process.env.ARBITRUM_RPC_URL || '',
    OPTIMISM_RPC_URL: process.env.OPTIMISM_RPC_URL || '',
    MAINNET_RPC_URL: process.env.INFURA_MAINNET_RPC_URL || '',
  }
} as const;

export type AppConfig = typeof appConfig;

// packages/worker/src/utils/rpc-handler.ts - "PROJECT SECRET" İLE GÜVENLİ HALE GETİRİLMİŞ NİHAİ VERSİYON

import { createPublicClient, http } from 'viem';
import { polygonAmoy, mainnet, bsc, avalanche, base, arbitrum, optimism } from 'viem/chains';
import type { Env } from '../types.js';

const FALLBACK_LOG_INTERVAL_MS = 60_000;
const fallbackLogTimestamps: Record<number, number> = {};

type AnyPublicClient = ReturnType<typeof createPublicClient>;

const CHAIN_CONFIGS = {
  [polygonAmoy.id]: {
    name: 'Polygon Amoy',
    fallbackRpcSecretName: 'INFURA_AMOY_RPC_URL',
    timeout: 2000 // Timeout'u biraz artıralım
  },
  [mainnet.id]: {
    name: 'Ethereum Mainnet',
    fallbackRpcSecretName: 'INFURA_MAINNET_RPC_URL',
    timeout: 2000
  },
  [bsc.id]: {
    name: 'Binance Smart Chain',
    fallbackRpcSecretName: 'INFURA_BSC_RPC_URL',
    timeout: 2000
  },
  [avalanche.id]: {
    name: 'Avalanche',
    fallbackRpcSecretName: 'INFURA_AVALANCHE_RPC_URL',
    timeout: 2000
  },
  [base.id]: {
    name: 'Base',
    fallbackRpcSecretName: 'INFURA_BASE_RPC_URL',
    timeout: 2000
  },
  [arbitrum.id]: {
    name: 'Arbitrum',
    fallbackRpcSecretName: 'INFURA_ARBITRUM_RPC_URL',
    timeout: 2000
  },
  [optimism.id]: {
    name: 'Optimism',
    fallbackRpcSecretName: 'OPTIMISM_RPC_URL',
    timeout: 2000
  },
  // Diğer ağlar...
};

function encodeBase64(value: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value).toString('base64');
  }
  if (typeof btoa !== 'undefined') {
    return btoa(value);
  }
  throw new Error('Base64 encoder is not available in this runtime.');
}

function extractInfuraProjectId(rpcUrl: string): string | null {
  const match = /\/v3\/([^/?]+)/.exec(rpcUrl);
  return match?.[1] ?? null;
}

// YARDIMCI FONKSİYON: Güvenli RPC URL'ini oluşturan fonksiyon
function getAuthenticatedRpcUrl(env: Env, rpcUrlSecretName: keyof Env): string {
  const rpcUrl = env[rpcUrlSecretName] as string | undefined;
  if (!rpcUrl) {
    throw new Error(`CRITICAL: RPC URL secret '${rpcUrlSecretName}' is not defined in Cloudflare environment.`);
  }
  return rpcUrl;
}

function createAuthAwareTransport(rpcUrl: string, env: Env, timeout = 2000) {
  const projectSecret = env.INFURA_PROJECT_SECRET;
  const projectId = projectSecret ? extractInfuraProjectId(rpcUrl) : null;

  if (projectSecret && projectId) {
    const authHeader = `Basic ${encodeBase64(`${projectId}:${projectSecret}`)}`;
    return http(rpcUrl, {
      timeout,
      fetchOptions: {
        headers: {
          Authorization: authHeader,
        },
      },
    });
  }

  return http(rpcUrl, { timeout });
}

function logFallbackUsage(chainId: number) {
  const now = Date.now();
  const lastLogged = fallbackLogTimestamps[chainId] || 0;
  if (now - lastLogged >= FALLBACK_LOG_INTERVAL_MS) {
    console.log(`[RPC-HANDLER] Fallback RPC in use for chain ${chainId}.`);
    fallbackLogTimestamps[chainId] = now;
  }
}


export async function getPublicClientWithFallback(chainId: number, env: Env, userRpcUrl?: string): Promise<AnyPublicClient> {
  const config = CHAIN_CONFIGS[chainId] || CHAIN_CONFIGS[polygonAmoy.id];
  
  try {
    // ⭐ DEĞİŞİKLİK BURADA: Artık güvenli URL'i oluşturan fonksiyonu çağırıyoruz.
    const fallbackRpcUrl = getAuthenticatedRpcUrl(env, config.fallbackRpcSecretName);

    // Önce kullanıcı RPC'sini dene
    if (userRpcUrl) {
      try {
        const userClient = await createUserClient(chainId, userRpcUrl, config.timeout);
        if (userClient) {
          console.log(`[RPC-HANDLER] Successfully connected to user RPC for chain ${chainId}.`);
          return userClient;
        }
      } catch (userErr) {
        console.warn(`[RPC-HANDLER] User RPC failed for chain ${chainId}:`, userErr);
      }
    }

    // Kullanıcı RPC başarısızsa fallback'e geç
    const fallbackClient = await createFallbackClient(chainId, fallbackRpcUrl, config.timeout, env);
    logFallbackUsage(chainId);
    return fallbackClient;
    
  } catch (error) {
    console.error(`[RPC-HANDLER-ERROR] Chain ${chainId} için RPC hatası:`, error);
    
    // Son çare olarak sadece fallback client'ı daha uzun timeout ile dene
    console.warn(`[RPC-HANDLER-FALLBACK] Retrying with fallback RPC only...`);
    const fallbackRpcUrl = getAuthenticatedRpcUrl(env, config.fallbackRpcSecretName);
    return createFallbackClient(chainId, fallbackRpcUrl, config.timeout * 2, env);
  }
}

// Bu yardımcı fonksiyonlar aynı kalıyor...
async function createUserClient(chainId: number, userRpcUrl: string | undefined, timeout: number): Promise<AnyPublicClient | null> {
  if (!userRpcUrl) return null;

  const client = createPublicClient({
    chain: getChainById(chainId),
    transport: http(userRpcUrl, { timeout })
  });

  await client.getBlockNumber(); // Bağlantıyı test et
  return client as AnyPublicClient;
}

async function createFallbackClient(chainId: number, rpcUrl: string, timeout: number, env: Env): Promise<AnyPublicClient> {
  const client = createPublicClient({
    chain: getChainById(chainId),
    transport: createAuthAwareTransport(rpcUrl, env, timeout)
  });

  await client.getBlockNumber(); // Bağlantıyı test et
  return client as AnyPublicClient;
}

function getChainById(chainId: number) {
  switch (chainId) {
    case mainnet.id: return mainnet;
    case polygonAmoy.id: return polygonAmoy;
    case bsc.id: return bsc;
    case avalanche.id: return avalanche;
    case base.id: return base;
    case optimism.id: return optimism;
    case arbitrum.id: return arbitrum;
    default: return polygonAmoy;
  }
}

export function createSecureHttpTransport(rpcUrl: string, env: Env, timeout = 2000) {
  return createAuthAwareTransport(rpcUrl, env, timeout);
}

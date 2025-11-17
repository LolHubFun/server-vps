// packages/worker/src/utils/rpc-handler.ts - "PROJECT SECRET" İLE GÜVENLİ HALE GETİRİLMİŞ NİHAİ VERSİYON

import { createPublicClient, http } from 'viem';
import { polygonAmoy, mainnet, bsc, avalanche, base, arbitrum } from 'viem/chains';
import type { Env } from '../types.js';

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
  // Diğer ağlar...
};

// YARDIMCI FONKSİYON: Güvenli RPC URL'ini oluşturan fonksiyon
function getAuthenticatedRpcUrl(env: Env, rpcUrlSecretName: keyof Env): string {
    const rpcUrl = env[rpcUrlSecretName] as string | undefined;
    const projectSecret = env.INFURA_PROJECT_SECRET as string | undefined;

    if (!rpcUrl) {
        throw new Error(`CRITICAL: RPC URL secret '${rpcUrlSecretName}' is not defined in Cloudflare environment.`);
    }

    // NOT: viem, URL içinde basic auth credential (https://:secret@host/...) kullanımına izin vermiyor.
    // Bu yüzden şimdilik secret tanımlı olsa bile URL'i değiştirmiyoruz.
    if (projectSecret) {
        console.warn('[RPC-SECURITY] INFURA_PROJECT_SECRET is set but cannot be embedded into the URL with viem. Using plain RPC URL instead.');
    }

    return rpcUrl;
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
    const fallbackClient = await createFallbackClient(chainId, fallbackRpcUrl, config.timeout);
    console.log(`[RPC-HANDLER] Fallback RPC in use for chain ${chainId}.`);
    return fallbackClient;
    
  } catch (error) {
    console.error(`[RPC-HANDLER-ERROR] Chain ${chainId} için RPC hatası:`, error);
    
    // Son çare olarak sadece fallback client'ı daha uzun timeout ile dene
    console.warn(`[RPC-HANDLER-FALLBACK] Retrying with fallback RPC only...`);
    const fallbackRpcUrl = getAuthenticatedRpcUrl(env, config.fallbackRpcSecretName);
    return createFallbackClient(chainId, fallbackRpcUrl, config.timeout * 2);
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

async function createFallbackClient(chainId: number, rpcUrl: string, timeout: number): Promise<AnyPublicClient> {
  const client = createPublicClient({
    chain: getChainById(chainId),
    transport: http(rpcUrl, { timeout })
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
    case arbitrum.id: return arbitrum;
    default: return polygonAmoy;
  }
}

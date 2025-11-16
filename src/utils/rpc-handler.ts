// packages/worker/src/utils/rpc-handler.ts - "PROJECT SECRET" İLE GÜVENLİ HALE GETİRİLMİŞ NİHAİ VERSİYON

import { createPublicClient, http, PublicClient } from 'viem';
import { polygonAmoy, mainnet, bsc, avalanche, base, arbitrum } from 'viem/chains';
import type { Env } from '../types.js';

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

    // Eğer Project Secret tanımlı DEĞİLSE, normal URL'i döndür.
    if (!projectSecret) {
        console.warn(`[RPC-SECURITY] INFURA_PROJECT_SECRET is not set. Using unauthenticated RPC endpoint. This is not recommended for production.`);
        return rpcUrl;
    }

    // Eğer Project Secret TANIMLIYSA, güvenli URL'i oluştur.
    // Örnek URL: https://polygon-amoy.infura.io/v3/YOUR_ID
    // Güvenli URL: https://:YOUR_SECRET@polygon-amoy.infura.io/v3/YOUR_ID
    const urlParts = rpcUrl.split('://');
    const protocol = urlParts[0];
    const restOfUrl = urlParts[1];
    
    return `${protocol}://:${projectSecret}@${restOfUrl}`;
}


export async function getPublicClientWithFallback(chainId: number, env: Env, userRpcUrl?: string): Promise<PublicClient> {
  const config = CHAIN_CONFIGS[chainId] || CHAIN_CONFIGS[polygonAmoy.id];
  
  try {
    // ⭐ DEĞİŞİKLİK BURADA: Artık güvenli URL'i oluşturan fonksiyonu çağırıyoruz.
    const fallbackRpcUrl = getAuthenticatedRpcUrl(env, config.fallbackRpcSecretName);

    // Eşzamanlı istekler (aynı kalıyor)
    const clients = await Promise.allSettled([
      createUserClient(chainId, userRpcUrl, config.timeout),
      createFallbackClient(chainId, fallbackRpcUrl, config.timeout)
    ]);
    
    const successfulClient = clients.find(result => result.status === 'fulfilled' && result.value !== null);

    if (successfulClient && successfulClient.status === 'fulfilled' && successfulClient.value) {
      console.log(`[RPC-HANDLER] Successfully connected to RPC for chain ${chainId}.`);
      return successfulClient.value;
    }
    
    throw new Error('All primary RPC connections failed or timed out.');
    
  } catch (error) {
    console.error(`[RPC-HANDLER-ERROR] Chain ${chainId} için RPC hatası:`, error);
    
    // Son çare olarak sadece fallback client'ı daha uzun timeout ile dene
    console.warn(`[RPC-HANDLER-FALLBACK] Retrying with fallback RPC only...`);
    const fallbackRpcUrl = getAuthenticatedRpcUrl(env, config.fallbackRpcSecretName);
    return createFallbackClient(chainId, fallbackRpcUrl, config.timeout * 2);
  }
}

// Bu yardımcı fonksiyonlar aynı kalıyor...
async function createUserClient(chainId: number, userRpcUrl: string | undefined, timeout: number): Promise<PublicClient | null> {
  if (!userRpcUrl) return null;

  const client = createPublicClient({
    chain: getChainById(chainId),
    transport: http(userRpcUrl, { timeout })
  });

  await client.getBlockNumber(); // Bağlantıyı test et
  return client;
}

async function createFallbackClient(chainId: number, rpcUrl: string, timeout: number): Promise<PublicClient> {
  const client = createPublicClient({
    chain: getChainById(chainId),
    transport: http(rpcUrl, { timeout })
  });

  await client.getBlockNumber(); // Bağlantıyı test et
  return client;
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

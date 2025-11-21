// packages/worker/src/services/metrics.service.ts - MULTICALL İLE GÜNCELLENMİŞ VERSİYON

import { createPublicClient } from 'viem';
import { polygonAmoy, mainnet, bsc, avalanche, base, arbitrum, optimism, polygon } from 'viem/chains';
import { lolhubFunTokenABI } from '../lib/abi/lolhubFunTokenABI.js';
import type { Env } from '../types.js';
import { createSecureHttpTransport } from '../utils/rpc-handler.js';

export interface ProjectMetrics {
  contractAddress: string;
  chainId: number;
  totalRaised: string;
  marketCap: string;
  holdersCount: number;
  volume24h: string;
  priceChange24h: number;
  currentPrice: string; // in wei per token (fixed-point 1e18)
  totalSupply: string;
  contractTokenBalance: string;
}

/**
 * Verilen proje listesi için tüm on-chain verileri TEK BİR multicall isteği ile çeker.
 * @param projects Çekilecek projelerin adres listesi.
 * @param env Worker ortam değişkenleri.
 * @returns Her proje için hesaplanmış metrikleri içeren bir dizi.
 */
export async function calculateBatchMetrics(
  projects: { contract_address: string; chain_id?: number }[],
  env: Env
): Promise<ProjectMetrics[]> {
  if (!projects || projects.length === 0) {
    return [];
  }

  // Zincire göre client sağlayıcı
  const getClientForChain = (chainId?: number) => {
    const withDefault = (primary?: string, fallback?: string) => primary || fallback;

    switch (chainId) {
      case 1:
        return createPublicClient({ chain: mainnet, transport: createSecureHttpTransport(withDefault(env.INFURA_MAINNET_RPC_URL, env.INFURA_AMOY_RPC_URL)!, env) });
      case 56:
        return createPublicClient({ chain: bsc, transport: createSecureHttpTransport(withDefault(env.BSC_RPC_URL, env.INFURA_AMOY_RPC_URL)!, env) });
      case 137:
        return createPublicClient({ chain: polygon, transport: createSecureHttpTransport(withDefault(env.POLYGON_RPC_URL, env.INFURA_AMOY_RPC_URL)!, env) });
      case 43114:
        return createPublicClient({ chain: avalanche, transport: createSecureHttpTransport(withDefault(env.AVAX_RPC_URL, env.INFURA_AMOY_RPC_URL)!, env) });
      case 8453:
        return createPublicClient({ chain: base, transport: createSecureHttpTransport(withDefault(env.BASE_RPC_URL, env.INFURA_AMOY_RPC_URL)!, env) });
      case 42161:
        return createPublicClient({ chain: arbitrum, transport: createSecureHttpTransport(withDefault(env.ARBITRUM_RPC_URL, env.INFURA_AMOY_RPC_URL)!, env) });
      case 10:
        return createPublicClient({ chain: optimism, transport: createSecureHttpTransport(withDefault(env.OPTIMISM_RPC_URL, env.INFURA_AMOY_RPC_URL)!, env) });
      case 80002:
      default:
        return createPublicClient({ chain: polygonAmoy, transport: createSecureHttpTransport(env.INFURA_AMOY_RPC_URL, env) });
    }
  };

  // Gruplama
  const groups = new Map<number, { contract_address: string; chain_id?: number }[]>();
  for (const p of projects) {
    const id = p.chain_id ?? 80002;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(p);
  }

  const metrics: ProjectMetrics[] = [];

  for (const [chainId, list] of groups.entries()) {
    const client = getClientForChain(chainId);
    const calls = list.flatMap(project => {
      const contract = { address: project.contract_address as `0x${string}`, abi: lolhubFunTokenABI };
      return [
        { ...contract, functionName: 'totalRaised' },
        { ...contract, functionName: 'totalSupply' },
        { ...contract, functionName: 'balanceOf', args: [project.contract_address as `0x${string}`] },
      ];
    });

    try {
      const res = await (client as any).multicall({ contracts: calls as any, allowFailure: true }) as any[];
      for (let i = 0; i < list.length; i++) {
        const projectAddress = list[i].contract_address;
        const idx = i * 3;
        const totalRaisedResult = res[idx];
        const totalSupplyResult = res[idx + 1];
        const contractBalanceResult = res[idx + 2];
        if (
          totalRaisedResult.status === 'failure' ||
          totalSupplyResult.status === 'failure' ||
          contractBalanceResult.status === 'failure'
        ) {
          console.error(`[METRICS-MULTICALL-FAILURE][chain=${chainId}] ${projectAddress}`);
          continue;
        }
        const totalRaised = totalRaisedResult.result as bigint;
        const totalSupply = totalSupplyResult.result as bigint;
        const contractTokenBalance = contractBalanceResult.result as bigint;
        const soldSupply = totalSupply - contractTokenBalance;
        // If no tokens have been sold yet, show market cap as 0 to reflect the seed state
        let marketCap: bigint;
        if (soldSupply === 0n) {
          marketCap = 0n;
        } else {
          const currentPrice = BigInt(10000000000000) + (soldSupply * BigInt(1000000000)) / BigInt(10**18);
          marketCap = (currentPrice * totalSupply) / BigInt(10**18);
          
          // push with computed fields
        }
        const currentPriceCalc = soldSupply === 0n 
          ? 0n 
          : (BigInt(10000000000000) + (soldSupply * BigInt(1000000000)) / BigInt(10**18));

        metrics.push({
          contractAddress: projectAddress,
          chainId: chainId,
          totalRaised: totalRaised.toString(),
          marketCap: marketCap.toString(),
          holdersCount: 0,
          volume24h: '0',
          priceChange24h: 0,
          currentPrice: currentPriceCalc.toString(),
          totalSupply: totalSupply.toString(),
          contractTokenBalance: contractTokenBalance.toString(),
        });
      }
    } catch (e) {
      console.error(`[METRICS-MULTICALL-FATAL][chain=${chainId}]`, e);
    }
  }

  return metrics;
}

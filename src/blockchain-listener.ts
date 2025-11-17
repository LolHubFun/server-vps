// src/blockchain-listener.ts - NODE.JS İÇİN TAM VE NİHAİ VERSİYON (İMPORT YOLLARI DÜZELTİLDİ)

import { parseAbiItem } from 'viem';
import type { Pool } from 'pg';

// DİKKAT: TÜM İMPORT YOLLARININ SONUNA .js EKLENDİ
import { getPublicClientWithFallback } from './utils/rpc-handler.js';
import { verifyProxyContract } from './services/verification.service.js';
import type { CacheService } from './cache.service.js';
import type { Env } from './types.js';

const evmTokenCreatedAbi = parseAbiItem('event TokenCreated(address indexed tokenAddress, address indexed implementationAddress, address indexed creator, string evolutionMode, uint256 chainId)');

// Basit bir kilit mekanizması, aynı anda iki dinleme işleminin çalışmasını engeller
let isPolling = false; 

// Yardımcı fonksiyon: chainId'yi isme çevirir
function getChainInfoById(chainId: number): { id: number; name: string } {
    const chains: { [key: number]: string } = {
        1: 'ethereum', 56: 'bsc', 137: 'polygon', 80002: 'polygon-amoy',
        43114: 'avalanche', 8453: 'base', 42161: 'arbitrum', 10: 'optimism'
    };
    return { id: chainId, name: chains[chainId] || 'unknown' };
}

export async function pollForTokenCreatedEvents(db: Pool, cache: CacheService, env: Env) {
    if (isPolling) {
        // console.log('[POLL] Polling already in progress. Skipping.'); // Çok fazla log olmaması için yorum satırı yapıldı
        return;
    }
    isPolling = true;
    
    try {
        const publicClient = await getPublicClientWithFallback(80002, env); // Varsayılan olarak Amoy'a bağlanır
        if (!publicClient) throw new Error("RPC client could not be created.");

        // Son kontrol edilen bloğu veritabanından oku
        const { rows: lastBlockRows } = await db.query<{ value: string }>('SELECT value FROM app_state WHERE key = $1', ['lastCheckedBlock']);
        let lastCheckedBlock = lastBlockRows.length > 0 ? BigInt(lastBlockRows[0].value) : 0n;
        
        const latestBlock = await publicClient.getBlockNumber();
        if (lastCheckedBlock === 0n) {
            lastCheckedBlock = latestBlock > 20n ? latestBlock - 20n : 0n; // İlk çalıştırmada sadece son 20 bloğu kontrol et
        }

        if (latestBlock <= lastCheckedBlock) {
            return; // finally bloğu isPolling'i false yapacak
        }

        const logs = await publicClient.getLogs({
            address: env.FACTORY_CONTRACT_ADDRESS as `0x${string}`,
            event: evmTokenCreatedAbi,
            fromBlock: lastCheckedBlock + 1n,
            toBlock: latestBlock
        });

        if (logs.length > 0) {
            console.log(`[POLL] Found ${logs.length} new TokenCreated event(s).`);
            for (const log of logs) {
                await processEvmTokenCreated(log, db, env, cache);
            }
        }

        // Son kontrol edilen bloğu veritabanına kaydet
        await db.query(
            `INSERT INTO app_state (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            ['lastCheckedBlock', latestBlock.toString()]
        );

    } catch (e: any) {
        console.error("[POLL-FATAL] Polling failed:", e.message);
    } finally {
        isPolling = false;
    }
}

async function processEvmTokenCreated(log: any, db: Pool, env: Env, cache: CacheService) {
    try {
        const { tokenAddress, creator, evolutionMode, chainId } = log.args as any;
        const txHash = log.transactionHash;

        const chainInfo = getChainInfoById(Number(chainId ?? 80002));

        console.log(`[PROCESS-EVENT] Mode='${evolutionMode}', Token='${tokenAddress}', Chain='${chainInfo.name}'`);
        
        let result;

        if (evolutionMode === 'standard') {
            const preSaveData = await cache.get<any>(`presave:${txHash}`);

            if (!preSaveData) {
                console.error(`[PROCESS-ERROR] Standard mode but NO pre-save data in cache for tx: ${txHash}.`);
                result = await db.query(
                    `INSERT INTO projects (contract_address, creator_address, evolution_mode, chain_id, chain_name, evolution_status, created_at)
                     VALUES ($1, $2, $3, $4, $5, 'IDLE', NOW())
                     ON CONFLICT (contract_address) DO NOTHING RETURNING *`,
                    [tokenAddress.toLowerCase(), creator.toLowerCase(), evolutionMode, chainInfo.id, chainInfo.name]
                );
            } else {
                result = await db.query(
                    `INSERT INTO projects (contract_address, creator_address, evolution_mode, chain_id, chain_name, current_name, current_symbol, current_logo_url, website_url, twitter_url, telegram_url, discord_url, evolution_status, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'IDLE', NOW())
                     ON CONFLICT (contract_address) DO UPDATE SET 
                        current_name = EXCLUDED.current_name,
                        current_symbol = EXCLUDED.current_symbol,
                        current_logo_url = EXCLUDED.current_logo_url,
                        updated_at = NOW()
                     RETURNING *`,
                    [
                        tokenAddress.toLowerCase(),
                        creator.toLowerCase(),
                        evolutionMode,
                        chainInfo.id,
                        chainInfo.name,
                        preSaveData.name,
                        preSaveData.symbol,
                        preSaveData.logoUrl,
                        preSaveData.socials?.website,
                        preSaveData.socials?.twitter,
                        preSaveData.socials?.telegram,
                        preSaveData.socials?.discord,
                    ]
                );
                await cache.delete(`presave:${txHash}`);
            }
        } else { // Democracy or Chaos
            const temporaryName = evolutionMode === 'democracy' ? 'Democracy Project' : 'Chaos Project';
            result = await db.query(
                `INSERT INTO projects (contract_address, creator_address, evolution_mode, chain_id, chain_name, current_name, evolution_status, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, 'IDLE', NOW())
                 ON CONFLICT (contract_address) DO NOTHING RETURNING *`,
                [tokenAddress.toLowerCase(), creator.toLowerCase(), evolutionMode, chainInfo.id, chainInfo.name, temporaryName]
            );
        }

        if (result && result.rowCount && result.rowCount > 0) {
            console.log(`[DB-SUCCESS] Project saved: ${tokenAddress}`);
            
            try {
                const chainIdToVerify = Number(chainId ?? 80002);
                console.log(`[VERIFY-TRIGGER] Auto-verifying: ${tokenAddress} on chainId ${chainIdToVerify}`);
                verifyProxyContract(env, tokenAddress, chainIdToVerify);
            } catch (verificationError) {
                console.error(`[VERIFY-TRIGGER-ERROR] Could not start verification for ${tokenAddress}:`, verificationError);
            }
        } else {
            console.warn(`[DB-WARN] Project ${tokenAddress} might already exist. Insert/Update did not affect any rows.`);
        }
    } catch (e: any) {
        console.error(`[PROCESS-FATAL] CRASH in processEvmTokenCreated for ${log.transactionHash}:`, e.message);
    }
}

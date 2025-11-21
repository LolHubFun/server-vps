// src/blockchain-listener.ts - NODE.JS İÇİN TAM VE NİHAİ VERSİYON (İMPORT YOLLARI DÜZELTİLDİ)

import { parseAbiItem } from 'viem';
import type { Pool } from 'pg';

// DİKKAT: TÜM İMPORT YOLLARININ SONUNA .js EKLENDİ
import { getPublicClientWithFallback } from './utils/rpc-handler.js';
import { verifyProxyContract } from './services/verification.service.js';
import type { CacheService } from './cache.service.js';
import type { Env } from './types.js';
import { handleInvestedEvent, handleSoldEvent } from './event-listener.js';
import { handleFinalizationLogic } from './services/finalization.service.js';

const evmTokenCreatedAbi = parseAbiItem('event TokenCreated(address indexed tokenAddress, address indexed implementationAddress, address indexed creator, string evolutionMode, uint256 chainId)');
const investedEventAbi = parseAbiItem('event Invested(address indexed buyer, uint256 amountIn, uint256 tokensOut, address referrer, uint256 blockNumber)');
const soldEventAbi = parseAbiItem('event Sold(address indexed seller, uint256 tokensIn, uint256 amountOut, uint256 blockNumber)');
const finalizedEventAbi = parseAbiItem('event ProjectFinalized(address indexed lpPair)');

// Basit bir kilit mekanizması, aynı anda iki dinleme işleminin çalışmasını engeller
let isPolling = false; 
let isPollingProjectEvents = false;

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

export async function pollForProjectEvents(db: Pool, cache: CacheService, env: Env) {
    if (isPollingProjectEvents) {
        return;
    }
    isPollingProjectEvents = true;

    try {
        const { rows: activeProjects } = await db.query<{ contract_address: string; chain_id: number }>(
            `SELECT contract_address, chain_id
               FROM projects
              WHERE is_finalized = false
              ORDER BY last_interaction_timestamp DESC
              LIMIT 10`
        );

        if (activeProjects.length === 0) {
            return;
        }

        for (const project of activeProjects) {
            const chainId = Number(project.chain_id || 80002);

            let publicClient: any;
            try {
                publicClient = await getPublicClientWithFallback(chainId, env);
            } catch (e) {
                console.error(`[POLL-PROJECTS] Failed to create public client for ${project.contract_address} on chain ${chainId}:`, e);
                continue;
            }

            let latestBlock: bigint;
            try {
                latestBlock = await publicClient.getBlockNumber();
            } catch (e) {
                console.error(`[POLL-PROJECTS] Failed to read latest block for ${project.contract_address} on chain ${chainId}:`, e);
                continue;
            }

            // ⭐ KRİTİK DEĞİŞİKLİK: 50000 yerine 2000 yapıldı.
            const window = 2000n;
            const fromBlock = latestBlock > window ? latestBlock - window : 0n;

            try {
                const investedLogs = await publicClient.getLogs({
                    address: project.contract_address as `0x${string}`,
                    event: investedEventAbi,
                    fromBlock,
                    toBlock: latestBlock,
                });

                for (const log of investedLogs) {
                    await handleInvestedEvent(
                        {
                            blockNumber: log.blockNumber,
                            transactionHash: log.transactionHash,
                            logIndex: Number(log.logIndex),
                            contractAddress: log.address as string,
                            eventData: { args: log.args },
                        },
                        db,
                        cache,
                        env,
                    );
                }
            } catch (e) {
                console.error(`[POLL-PROJECTS] Failed to poll Invested events for ${project.contract_address} on chain ${chainId}:`, e);
            }

            try {
                const soldLogs = await publicClient.getLogs({
                    address: project.contract_address as `0x${string}`,
                    event: soldEventAbi,
                    fromBlock,
                    toBlock: latestBlock,
                });

                for (const log of soldLogs) {
                    await handleSoldEvent(
                        {
                            blockNumber: log.blockNumber,
                            transactionHash: log.transactionHash,
                            logIndex: Number(log.logIndex),
                            contractAddress: log.address as string,
                            eventData: { args: log.args },
                        },
                        db,
                        cache,
                        env,
                    );
                }
            } catch (e) {
                console.error(`[POLL-PROJECTS] Failed to poll Sold events for ${project.contract_address} on chain ${chainId}:`, e);
            }

            try {
                const finalizedLogs = await publicClient.getLogs({
                    address: project.contract_address as `0x${string}`,
                    event: finalizedEventAbi,
                    fromBlock,
                    toBlock: latestBlock,
                });

                for (const log of finalizedLogs) {
                    await handleFinalizationLogic(
                        log.address,
                        log.args?.lpPair as string,
                        db,
                        env
                    );
                }
            } catch (e) {
                console.error(`[POLL-PROJECTS] Failed to poll Finalized events for ${project.contract_address}:`, e);
            }
        }
    } catch (e: any) {
        console.error('[POLL-PROJECTS-FATAL] Polling project events failed:', e.message || e);
    } finally {
        isPollingProjectEvents = false;
    }
}

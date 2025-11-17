// FAYL: worker/src/event-listener.ts - GÜÇLENDİRİLMİŞ REPLAY ATTACK KORUMASI İLE NİHAİ VERSİYON

import type { Pool } from 'pg';
import { createPublicClient, http, decodeFunctionData, getContract } from 'viem';
import { polygonAmoy } from 'viem/chains';
import { checkAndTriggerEvolution } from './evolution-engine.js';
import type { CacheService } from './cache.service.js';
import type { Env, EventWithMetadata } from './types.js';
import { lolhubFunTokenABI } from './lib/abi/lolhubFunTokenABI.js';

const MILESTONES = [
    { target: BigInt("1000000000000000000"), name: "Milestone 1" },
    { target: BigInt("2000000000000000000"), name: "Milestone 2" },
];

const processedEvents = new Map<string, { timestamp: number }>();

export async function handleInvestedEvent(event: EventWithMetadata, db: Pool, cache: CacheService, env: Env) {
  if (processedEvents.size > 50) {
    const now = Date.now();
    for (const [key, value] of processedEvents.entries()) {
      if (now - value.timestamp > 1800000) { // 30 dakikadan eski ise
        processedEvents.delete(key);
      }
    }
  }
  
  const { blockNumber, transactionHash, logIndex, contractAddress } = event;
  const eventId = `${transactionHash}_${logIndex}`;

  if (processedEvents.has(eventId)) {
    console.log(`[REPLAY-DETECTED] Already processed event via in-memory cache: ${eventId}`);
    return;
  }

  console.log(`[EVENT-HANDLER] Processing Invested event for ${contractAddress} at block ${blockNumber}`);

  try {
    const existsResult = await db.query(
      `SELECT 1 FROM project_events 
        WHERE tx_hash = $1 
          AND event_name = 'Invested' 
          AND contract_address = $2`,
      [transactionHash, contractAddress.toLowerCase()]
    );
    const existsCount = existsResult.rowCount ?? 0;

    if (existsCount > 0) {
        console.warn(`[DB-REPLAY-DETECTED] Event ${eventId} already exists in the database. Skipping.`);
        processedEvents.set(eventId, { timestamp: Date.now() });
        return;
    }

    await db.query(
      `INSERT INTO project_events (contract_address, block_number, tx_hash, event_name, event_data)
       VALUES ($1, $2, $3, 'Invested', $4)
       ON CONFLICT DO NOTHING`,
      [contractAddress.toLowerCase(), blockNumber.toString(), transactionHash, JSON.stringify(event.eventData)]
    );

    const publicClient = createPublicClient({ chain: polygonAmoy, transport: http(env.INFURA_AMOY_RPC_URL) });

    try {
      const tx = await publicClient.getTransaction({ hash: transactionHash as `0x${string}` });
      const decoded = decodeFunctionData({ abi: lolhubFunTokenABI as any, data: tx.input as `0x${string}` });
      if (decoded.functionName === 'invest' && Array.isArray(decoded.args)) {
        const [_referrer, nameSuggestion, charSuggestion] = decoded.args as [string, string, string, any];
        const investorAddress = (tx as any).from as string;
        if ((nameSuggestion && nameSuggestion.trim().length > 0) || (charSuggestion && charSuggestion.trim().length > 0)) {
          await db.query(
            `INSERT INTO suggestions (project_contract_address, suggester_address, name_suggestion, char_suggestion, created_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (project_contract_address, suggester_address) DO UPDATE SET
               name_suggestion = EXCLUDED.name_suggestion,
               char_suggestion = EXCLUDED.char_suggestion,
               created_at = NOW()`,
            [contractAddress.toLowerCase(), investorAddress.toLowerCase(), nameSuggestion || '', charSuggestion || '']
          );
          console.log(`[SUGGESTION] Saved suggestion from ${investorAddress} for ${contractAddress}`);
        }
      }
    } catch (suggErr) {
      console.error(`[SUGGESTION-ERROR] Failed to process suggestions for tx ${transactionHash}:`, suggErr);
    }

    const evolutionTriggered = await checkAndTriggerEvolution(contractAddress, db, cache, env);

    if (evolutionTriggered) {
        await cache.clearProjectCache(contractAddress.toLowerCase());
        console.log(`[CACHE] Evolution triggered - cleared cache for ${contractAddress.toLowerCase()}`);
    }

    console.log(`[EVENT-HANDLER] Successfully processed event for ${contractAddress} at block ${blockNumber}`);
    processedEvents.set(eventId, { timestamp: Date.now() });

  } catch (error) {
    console.error(`[EVENT-HANDLER-ERROR] Failed to process event for ${contractAddress} at block ${blockNumber}:`, error);
  }
}

export async function runConsistencyCheck(db: Pool, cache: CacheService, env: Env) {
  console.log('[CONSISTENCY-CHECK] Starting optimized consistency check');

  try {
    const { rows: projects } = await db.query(
      `SELECT contract_address, last_processed_block, current_milestone_index
         FROM projects
         WHERE evolution_status = 'IDLE'
           AND is_finalized = false
           AND last_interaction_timestamp > NOW() - INTERVAL '7 days'
         ORDER BY updated_at ASC
         LIMIT 25`
    );
    
    console.log(`[CONSISTENCY-CHECK] Found ${projects.length} projects to check`);

    const blockchainDataPromises = projects.map(project => 
      getProjectTotalRaised(project.contract_address, env).catch(error => {
        console.error(`[BLOCKCHAIN-ERROR] Failed to get data for ${project.contract_address}:`, error);
        return BigInt(0);
      })
    );
    
    const blockchainResults = await Promise.allSettled(blockchainDataPromises);
    
    const projectsToEvolve = projects.filter((project, index) => {
      const result = blockchainResults[index];
      if (result.status === 'fulfilled') {
        const blockchainValue = result.value;
        const currentMilestone = MILESTONES[project.current_milestone_index];
        return currentMilestone && blockchainValue >= currentMilestone.target;
      }
      return false;
    });
    
    console.log(`[CONSISTENCY-CHECK] ${projectsToEvolve.length} projects need evolution`);
    
    const evolutionPromises = projectsToEvolve.map((project, index) => {
      return new Promise(resolve => setTimeout(resolve, index * 2000)).then(() => 
        checkAndTriggerEvolution(project.contract_address, db, cache, env)
      );
    });
    
    await Promise.allSettled(evolutionPromises);
    
    console.log(`[CONSISTENCY-CHECK] Completed. ${projectsToEvolve.length} projects evolved.`);
    
  } catch (error) {
    console.error('[CONSISTENCY-CHECK] Critical error in consistency check:', error);
  }
}

async function getProjectTotalRaised(contractAddress: string, env: Env): Promise<bigint> {
  const publicClient = createPublicClient({
    chain: polygonAmoy,
    transport: http(env.INFURA_AMOY_RPC_URL)
  });
  
  const contract = getContract({
    address: contractAddress as `0x${string}`,
    abi: [
      { 
        inputs: [], 
        name: 'totalRaised', 
        outputs: [{ type: 'uint256' }], 
        stateMutability: 'view', 
        type: 'function' 
      }
    ],
    client: publicClient
  });
  
  return await contract.read.totalRaised();
}

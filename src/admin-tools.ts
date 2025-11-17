import type { Pool } from 'pg';
import { checkAndTriggerEvolution } from './evolution-engine.js';
import { Env } from './types.js';
import type { CacheService } from './cache.service.js';

export async function emergencyLockProject(
  projectAddress: string, 
  db: Pool, 
  reason: string,
  durationHours: number = 1
) {
  try {
    const result = await db.query(
      `UPDATE projects
        SET 
          evolution_status = 'EMERGENCY_LOCKED',
          emergency_lock_reason = $1,
          emergency_lock_timestamp = NOW()
        WHERE contract_address = $2`,
      [reason, projectAddress.toLowerCase()]
    );
    
    if (result.rowCount === 0) {
        return { success: false, message: `Project ${projectAddress} not found.` };
    }

    console.log(`[EMERGENCY-LOCK] Project ${projectAddress} locked for ${durationHours} hours: ${reason}`);
    return {
      success: true,
      message: `Project ${projectAddress} successfully locked for ${durationHours} hours`
    };
    
  } catch (error: any) {
    console.error(`[EMERGENCY-LOCK-ERROR] Failed to lock project ${projectAddress}:`, error);
    return {
      success: false,
      error: error.message
    };
  }
}

export async function manualTriggerEvolution(
  projectAddress: string,
  db: Pool,
  cache: CacheService,
  env: Env
) {
  try {
    // Önce acil durum kilidini kontrol et
    const { rows: lockCheck } = await db.query(
      `SELECT emergency_lock_reason 
         FROM projects 
         WHERE contract_address = $1
           AND emergency_lock_timestamp IS NOT NULL
           AND emergency_lock_timestamp > NOW() - INTERVAL '1 hour'`,
      [projectAddress.toLowerCase()]
    );
    
    if (lockCheck.length > 0) {
      return {
        success: false,
        message: `Project is emergency locked: ${lockCheck[0].emergency_lock_reason}`
      };
    }
    
    console.log(`[MANUAL-TRIGGER] Manually triggering evolution for ${projectAddress}`);
    const success = await checkAndTriggerEvolution(projectAddress, db, cache, env);
    
    return {
      success,
      message: success ? `Evolution successfully triggered for ${projectAddress}` : `No evolution needed or lock could not be acquired for ${projectAddress}`
    };
    
  } catch (error: any) {
    console.error(`[MANUAL-TRIGGER-ERROR] Failed to manually trigger evolution for ${projectAddress}:`, error);
    return {
      success: false,
      error: error.message
    };
  }
}

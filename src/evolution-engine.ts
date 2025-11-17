// worker/src/evolution-engine.ts - Evrim tetikleyicisi ve mod mantığı

import type { Pool } from 'pg';
import type { CacheService } from './cache.service.js';
import type { Env } from './types.js';

interface ProjectRow {
  contract_address: string;
  evolution_mode: 'standard' | 'democracy' | 'chaos';
  current_milestone_index: number;
  evolution_status: 'IDLE' | 'PROCESSING';
  total_raised: string;
}

const MILESTONES_WEI = [
  BigInt('100000000000000000000'), // 100 MATIC
  BigInt('500000000000000000000'),
  BigInt('1500000000000000000000'),
  BigInt('5000000000000000000000'),
];

export async function checkAndTriggerEvolution(
  contractAddress: string,
  db: Pool,
  cache: CacheService,
  env: Env
): Promise<boolean> {
  const lower = contractAddress.toLowerCase();

  const { rows } = await db.query<ProjectRow>(
    `SELECT contract_address, evolution_mode, current_milestone_index, evolution_status, total_raised
       FROM projects
       WHERE contract_address = $1
         AND is_finalized = false
         AND evolution_status = 'IDLE'
       LIMIT 1`,
    [lower]
  );

  if (rows.length === 0) {
    return false;
  }

  const project = rows[0];
  if (project.evolution_mode === 'standard') {
    return false;
  }

  const currentRaised = BigInt(project.total_raised || '0');
  const target = MILESTONES_WEI[project.current_milestone_index];
  if (!target || currentRaised < target) {
    return false;
  }

  const updateResult = await db.query(
    `UPDATE projects
       SET evolution_status = 'PROCESSING'
     WHERE contract_address = $1
       AND evolution_status = 'IDLE'
     RETURNING contract_address`,
    [lower]
  );

  if (updateResult.rowCount === 0) {
    return false;
  }

  try {
    await runEvolutionPipeline(project, db, env);
    await db.query(
      `UPDATE projects
         SET evolution_status = 'IDLE',
             current_milestone_index = current_milestone_index + 1
       WHERE contract_address = $1`,
      [lower]
    );
    await cache.clearProjectCache(lower);
    return true;
  } catch (error) {
    console.error('[EVOLUTION-ERROR]', error);
    await db.query(
      `UPDATE projects
         SET evolution_status = 'IDLE'
       WHERE contract_address = $1`,
      [lower]
    );
    return false;
  }
}

async function runEvolutionPipeline(project: ProjectRow, db: Pool, env: Env) {
  // Placeholder: actual implementation would pick suggestions, call AI, update DB.
  console.log(`[EVOLUTION] Running pipeline for ${project.contract_address} in mode ${project.evolution_mode}`);
  // Example of pulling suggestions and updating project name/logo would go here.
}

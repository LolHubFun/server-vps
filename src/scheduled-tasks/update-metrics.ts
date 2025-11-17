// packages/worker/src/scheduled-tasks/update-metrics.ts - GÜNCELLENMİŞ VE DAHA GÜVENLİ HALİ

import type { Pool } from 'pg';
import { calculateBatchMetrics } from '../services/metrics.service.js';
import type { Env } from '../types.js';
import type { CacheService } from '../cache.service.js';

export async function updateAllProjectMetrics(db: Pool, cache: CacheService, env: Env) {
  console.log('[CRON-METRICS] Starting metrics update...');
  try {
    // ⭐ DEĞİŞİKLİK: Sadece 10 projeyi alıyoruz.
    const { rows: activeProjects } = await db.query<{ contract_address: string; chain_id: number }>(
      `SELECT contract_address, chain_id FROM projects
       WHERE is_finalized = false
       ORDER BY last_interaction_timestamp ASC
       LIMIT 10`
    );

    if (activeProjects.length === 0) {
      console.log('[CRON-METRICS] No projects to update in this batch.');
      return;
    }

    console.log(`[CRON-METRICS] Found ${activeProjects.length} projects in this batch. Calculating metrics...`);

    const allMetrics = await calculateBatchMetrics(activeProjects, env);

    if (allMetrics.length === 0) {
        console.warn('[CRON-METRICS] Metric calculation returned no data.');
        return;
    }

    const promises = allMetrics.map(async (m) => {
      // 1) DB güncellemesi
      await db.query(
        `UPDATE projects
           SET total_raised = $1,
               market_cap = $2,
               holders_count = $3,
               volume_24h = $4,
               price_change_24h = $5,
               last_interaction_timestamp = NOW()
         WHERE contract_address = $6`,
        [
          m.totalRaised,
          m.marketCap,
          m.holdersCount,
          m.volume24h,
          m.priceChange24h,
          m.contractAddress,
        ]
      );

      // 2) KV: Saatlik fiyat snapshot yazımı
      const now = new Date();
      const hourKey = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}`;
      const snapKey = `prices:${m.chainId}:${m.contractAddress.toLowerCase()}:${hourKey}`;
      const snapVal = JSON.stringify({ price: m.currentPrice, ts: now.toISOString() });
      // ~8 gün TTL
      await cache.set(snapKey, snapVal, 60 * 60 * 24 * 8);

      // Yardımcı: belirli saat farkı için snapshot getir
      const getSnapshotPrice = async (hoursBack: number): Promise<bigint | null> => {
        const past = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
        const key = `${past.getUTCFullYear()}${String(past.getUTCMonth() + 1).padStart(2, '0')}${String(past.getUTCDate()).padStart(2, '0')}${String(past.getUTCHours()).padStart(2, '0')}`;
        const k = `prices:${m.chainId}:${m.contractAddress.toLowerCase()}:${key}`;
        const v = await cache.get<{ price?: string }>(k);
        if (v?.price) {
          try { return BigInt(v.price); } catch { return null; }
        }
        return null;
      };

      // 3) 2h ve 1w değişim hesapla (yakın snapshot bulunamazsa 0)
      const curPrice = (() => { try { return BigInt(m.currentPrice); } catch { return 0n; } })();
      const price2h = await getSnapshotPrice(2);
      const price1w = await getSnapshotPrice(24 * 7);

      const pct = (prev: bigint | null): number => {
        if (!prev || prev === 0n) return 0;
        const diff = Number(curPrice - prev);
        return (diff / Number(prev)) * 100;
      };

      const pc2h = pct(price2h);
      const pc1w = pct(price1w);

      // 4) Sidecar değişim kayıtları
      const sidecarKey = `pchange:${m.contractAddress.toLowerCase()}`;
      await cache.set(sidecarKey, { pc2h, pc1w, updatedAt: now.toISOString() }, 60 * 10);
    });

    await Promise.all(promises);
    console.log(`[CRON-METRICS] Successfully updated metrics for ${allMetrics.length} projects.`);

    // 5) KV ön-ısınma: popüler kombinasyonları cache'e yaz
    try {
      const sorts: Array<'new'|'hot'|'graduated'> = ['new','hot','graduated'];
      const modes: Array<'all'|'standard'|'democracy'|'chaos'> = ['all','standard','democracy','chaos'];
      const pages = [1,2,3];
      const limit = 21;
      for (const sortBy of sorts) {
        const isFinalized = sortBy === 'graduated';
        for (const mode of modes) {
          const isDynamicMode = mode === 'democracy' || mode === 'chaos';
          const sMaxAge = isDynamicMode ? 60 : 60;
          for (const page of pages) {
            const offset = (Math.max(1, page) - 1) * Math.min(100, limit);
            let projectData: any[];
            let totalResult: any[];
            if (sortBy === 'hot') {
              if (mode === 'all') {
                [projectData, totalResult] = await Promise.all([
                  db.query(
                    `SELECT contract_address, creator_address, current_name, current_symbol, current_logo_url, created_at, market_cap, price_change_24h, live_stream_url, evolution_mode, chain_id, chain_name, volume_24h
                     FROM projects WHERE is_finalized = $1
                     ORDER BY volume_24h DESC NULLS LAST, created_at DESC
                     LIMIT $2 OFFSET $3`,
                    [isFinalized, limit, offset]
                  ).then(r => r.rows),
                  db.query(`SELECT COUNT(*) FROM projects WHERE is_finalized = $1`, [isFinalized]).then(r => r.rows),
                ]);
              } else {
                [projectData, totalResult] = await Promise.all([
                  db.query(
                    `SELECT contract_address, creator_address, current_name, current_symbol, current_logo_url, created_at, market_cap, price_change_24h, live_stream_url, evolution_mode, chain_id, chain_name, volume_24h
                     FROM projects WHERE is_finalized = $1 AND evolution_mode = $2
                     ORDER BY volume_24h DESC NULLS LAST, created_at DESC
                     LIMIT $3 OFFSET $4`,
                    [isFinalized, mode, limit, offset]
                  ).then(r => r.rows),
                  db.query(`SELECT COUNT(*) FROM projects WHERE is_finalized = $1 AND evolution_mode = $2`, [isFinalized, mode]).then(r => r.rows),
                ]);
              }
            } else if (sortBy === 'graduated') {
              if (mode === 'all') {
                [projectData, totalResult] = await Promise.all([
                  db.query(
                    `SELECT contract_address, creator_address, current_name, current_symbol, current_logo_url, created_at, market_cap, price_change_24h, live_stream_url, evolution_mode, chain_id, chain_name, volume_24h
                     FROM projects WHERE is_finalized = $1
                     ORDER BY updated_at DESC
                     LIMIT $2 OFFSET $3`,
                    [isFinalized, limit, offset]
                  ).then(r => r.rows),
                  db.query(`SELECT COUNT(*) FROM projects WHERE is_finalized = $1`, [isFinalized]).then(r => r.rows),
                ]);
              } else {
                [projectData, totalResult] = await Promise.all([
                  db.query(
                    `SELECT contract_address, creator_address, current_name, current_symbol, current_logo_url, created_at, market_cap, price_change_24h, live_stream_url, evolution_mode, chain_id, chain_name, volume_24h
                     FROM projects WHERE is_finalized = $1 AND evolution_mode = $2
                     ORDER BY updated_at DESC
                     LIMIT $3 OFFSET $4`,
                    [isFinalized, mode, limit, offset]
                  ).then(r => r.rows),
                  db.query(`SELECT COUNT(*) FROM projects WHERE is_finalized = $1 AND evolution_mode = $2`, [isFinalized, mode]).then(r => r.rows),
                ]);
              }
            } else { // new
              if (mode === 'all') {
                [projectData, totalResult] = await Promise.all([
                  db.query(
                    `SELECT contract_address, creator_address, current_name, current_symbol, current_logo_url, created_at, market_cap, price_change_24h, live_stream_url, evolution_mode, chain_id, chain_name, volume_24h
                     FROM projects WHERE is_finalized = $1
                     ORDER BY created_at DESC
                     LIMIT $2 OFFSET $3`,
                    [isFinalized, limit, offset]
                  ).then(r => r.rows),
                  db.query(`SELECT COUNT(*) FROM projects WHERE is_finalized = $1`, [isFinalized]).then(r => r.rows),
                ]);
              } else {
                [projectData, totalResult] = await Promise.all([
                  db.query(
                    `SELECT contract_address, creator_address, current_name, current_symbol, current_logo_url, created_at, market_cap, price_change_24h, live_stream_url, evolution_mode, chain_id, chain_name, volume_24h
                     FROM projects WHERE is_finalized = $1 AND evolution_mode = $2
                     ORDER BY created_at DESC
                     LIMIT $3 OFFSET $4`,
                    [isFinalized, mode, limit, offset]
                  ).then(r => r.rows),
                  db.query(`SELECT COUNT(*) FROM projects WHERE is_finalized = $1 AND evolution_mode = $2`, [isFinalized, mode]).then(r => r.rows),
                ]);
              }
            }

            // sidecar merge
            const enriched = await Promise.all(projectData.map(async (p: any) => {
              try {
                const sidecar = await cache.get<{ pc2h?: number; pc1w?: number }>(`pchange:${p.contract_address.toLowerCase()}`);
                if (sidecar) {
                  p.price_change_2h = sidecar.pc2h;
                  p.price_change_1w = sidecar.pc1w;
                }
              } catch {}
              return p;
            }));

            const totalProjects = totalResult[0] ? parseInt(totalResult[0].count, 10) : 0;
            const totalPages = Math.ceil(totalProjects / limit);
            const payload = { success: true, projects: enriched, pagination: { currentPage: page, totalPages, totalProjects, limit } };
            const cacheKey = `projects:list:v16:p${page}:l${limit}:s${sortBy}:m${mode}`;
            await cache.set(cacheKey, payload, sMaxAge);
          }
        }
      }
      console.log('[CRON-PREWARM] KV warmed for popular combinations.');
    } catch (e) {
      console.warn('[CRON-PREWARM] Failed to prewarm KV:', e);
    }

  } catch (e) {
    console.error('[CRON-METRICS-FATAL] Metrics update process failed:', e);
  }
}

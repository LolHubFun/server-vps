// packages/worker/src/scheduled-tasks/update-metrics.ts - GÜNCELLENMİŞ VE DAHA GÜVENLİ HALİ

import { NeonQueryFunction } from '@neondatabase/serverless';
import { calculateBatchMetrics } from '../services/metrics.service.js';
import type { Env } from '../types.js';

export async function updateAllProjectMetrics(db: NeonQueryFunction<any, any>, env: Env) {
  console.log('[CRON-METRICS] Starting metrics update...');
  try {
    // ⭐ DEĞİŞİKLİK: Sadece 10 projeyi alıyoruz.
    const activeProjects = (await db`
      SELECT contract_address, chain_id FROM projects
      WHERE is_finalized = false
      ORDER BY last_interaction_timestamp ASC -- En uzun süre güncellenmeyeni önceliklendir
      LIMIT 10;
    `) as unknown as { contract_address: string; chain_id: number }[];

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
      await db`
        UPDATE projects
        SET
          total_raised = ${m.totalRaised},
          market_cap = ${m.marketCap},
          holders_count = ${m.holdersCount},
          volume_24h = ${m.volume24h},
          price_change_24h = ${m.priceChange24h},
          last_interaction_timestamp = NOW() 
        WHERE contract_address = ${m.contractAddress};
      `;

      // 2) KV: Saatlik fiyat snapshot yazımı
      const now = new Date();
      const hourKey = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}`;
      const snapKey = `prices:${m.chainId}:${m.contractAddress.toLowerCase()}:${hourKey}`;
      const snapVal = JSON.stringify({ price: m.currentPrice, ts: now.toISOString() });
      // ~8 gün TTL
      await env.KV_CACHE.put(snapKey, snapVal, { expirationTtl: 60 * 60 * 24 * 8 });

      // Yardımcı: belirli saat farkı için snapshot getir
      const getSnapshotPrice = async (hoursBack: number): Promise<bigint | null> => {
        const past = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
        const key = `${past.getUTCFullYear()}${String(past.getUTCMonth() + 1).padStart(2, '0')}${String(past.getUTCDate()).padStart(2, '0')}${String(past.getUTCHours()).padStart(2, '0')}`;
        const k = `prices:${m.chainId}:${m.contractAddress.toLowerCase()}:${key}`;
        const v = await env.KV_CACHE.get(k, { type: 'json' }) as any;
        if (v && v.price) {
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
      await env.KV_CACHE.put(sidecarKey, JSON.stringify({ pc2h, pc1w, updatedAt: now.toISOString() }), { expirationTtl: 60 * 10 });
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
            let projectData: any;
            let totalResult: any;
            if (sortBy === 'hot') {
              if (mode === 'all') {
                [projectData, totalResult] = (await Promise.all([
                  db`SELECT contract_address, creator_address, current_name, current_symbol, current_logo_url, created_at, market_cap, price_change_24h, live_stream_url, evolution_mode, chain_id, chain_name, volume_24h 
                      FROM projects WHERE is_finalized = ${isFinalized} ORDER BY volume_24h DESC NULLS LAST, created_at DESC LIMIT ${limit} OFFSET ${offset}`,
                  db`SELECT COUNT(*) FROM projects WHERE is_finalized = ${isFinalized}`
                ])) as unknown as [any[], any[]];
              } else {
                [projectData, totalResult] = (await Promise.all([
                  db`SELECT contract_address, creator_address, current_name, current_symbol, current_logo_url, created_at, market_cap, price_change_24h, live_stream_url, evolution_mode, chain_id, chain_name, volume_24h 
                      FROM projects WHERE is_finalized = ${isFinalized} AND evolution_mode = ${mode} ORDER BY volume_24h DESC NULLS LAST, created_at DESC LIMIT ${limit} OFFSET ${offset}`,
                  db`SELECT COUNT(*) FROM projects WHERE is_finalized = ${isFinalized} AND evolution_mode = ${mode}`
                ])) as unknown as [any[], any[]];
              }
            } else if (sortBy === 'graduated') {
              if (mode === 'all') {
                [projectData, totalResult] = (await Promise.all([
                  db`SELECT contract_address, creator_address, current_name, current_symbol, current_logo_url, created_at, market_cap, price_change_24h, live_stream_url, evolution_mode, chain_id, chain_name, volume_24h 
                      FROM projects WHERE is_finalized = ${isFinalized} ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`,
                  db`SELECT COUNT(*) FROM projects WHERE is_finalized = ${isFinalized}`
                ])) as unknown as [any[], any[]];
              } else {
                [projectData, totalResult] = (await Promise.all([
                  db`SELECT contract_address, creator_address, current_name, current_symbol, current_logo_url, created_at, market_cap, price_change_24h, live_stream_url, evolution_mode, chain_id, chain_name, volume_24h 
                      FROM projects WHERE is_finalized = ${isFinalized} AND evolution_mode = ${mode} ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`,
                  db`SELECT COUNT(*) FROM projects WHERE is_finalized = ${isFinalized} AND evolution_mode = ${mode}`
                ])) as unknown as [any[], any[]];
              }
            } else { // new
              if (mode === 'all') {
                [projectData, totalResult] = (await Promise.all([
                  db`SELECT contract_address, creator_address, current_name, current_symbol, current_logo_url, created_at, market_cap, price_change_24h, live_stream_url, evolution_mode, chain_id, chain_name, volume_24h 
                      FROM projects WHERE is_finalized = ${isFinalized} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
                  db`SELECT COUNT(*) FROM projects WHERE is_finalized = ${isFinalized}`
                ])) as unknown as [any[], any[]];
              } else {
                [projectData, totalResult] = (await Promise.all([
                  db`SELECT contract_address, creator_address, current_name, current_symbol, current_logo_url, created_at, market_cap, price_change_24h, live_stream_url, evolution_mode, chain_id, chain_name, volume_24h 
                      FROM projects WHERE is_finalized = ${isFinalized} AND evolution_mode = ${mode} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
                  db`SELECT COUNT(*) FROM projects WHERE is_finalized = ${isFinalized} AND evolution_mode = ${mode}`
                ])) as unknown as [any[], any[]];
              }
            }

            // sidecar merge
            const enriched = await Promise.all(projectData.map(async (p: any) => {
              try {
                const sidecar = await env.KV_CACHE.get(`pchange:${p.contract_address.toLowerCase()}`, { type: 'json' }) as any;
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
            await env.KV_CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: sMaxAge });
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

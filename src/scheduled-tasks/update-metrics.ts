// packages/worker/src/scheduled-tasks/update-metrics.ts - GÜNCELLENMİŞ VE DAHA GÜVENLİ HALİ

import type { Pool } from 'pg';
import { calculateBatchMetrics } from '../services/metrics.service.js';
import type { Env } from '../types.js';
import type { CacheService } from '../cache.service.js';

type TopHolderRow = {
  address: string;
  percentage: number;
  tag?: string;
  is_contract?: boolean;
};

const toBigIntSafe = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0n;
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0n;
    try {
      return trimmed.startsWith('0x') || trimmed.startsWith('0X') ? BigInt(trimmed) : BigInt(trimmed);
    } catch {
      return 0n;
    }
  }
  return 0n;
};

async function computeTopHolders(
  db: Pool,
  contractAddress: string,
  totalSupplyStr: string | undefined,
  contractTokenBalanceStr: string | undefined,
  limit: number = 50
): Promise<TopHolderRow[] | null> {
  const contract = contractAddress.toLowerCase();

  const totalSupply = toBigIntSafe(totalSupplyStr ?? '0');
  const contractTokenBalance = toBigIntSafe(contractTokenBalanceStr ?? '0');

  if (totalSupply <= 0n) {
    return null;
  }

  let events: { event_name: string; event_data: any }[] = [];
  try {
    const { rows } = await db.query<{ event_name: string; event_data: any }>(
      `SELECT event_name, event_data
         FROM project_events
        WHERE contract_address = $1
          AND event_name IN ('Invested', 'Sold')`,
      [contract]
    );
    events = rows;
  } catch (e) {
    console.error(`[METRICS-TOP-HOLDERS-QUERY-ERROR] ${contract}:`, e);
    return null;
  }

  const balances = new Map<string, bigint>();

  const addDelta = (addr: unknown, delta: bigint) => {
    if (delta === 0n) return;
    if (typeof addr !== 'string') return;
    const normalized = addr.toLowerCase();
    if (!normalized.startsWith('0x') || normalized.length !== 42) return;
    const prev = balances.get(normalized) ?? 0n;
    balances.set(normalized, prev + delta);
  };

  for (const row of events) {
    const data = row.event_data as any;
    const args = data?.args ?? {};

    if (row.event_name === 'Invested') {
      const buyer = (args as any).buyer ?? (args as any)[0];
      const tokensOutRaw = (args as any).tokensOut ?? (args as any)[2];
      const tokensOut = toBigIntSafe(tokensOutRaw);
      if (tokensOut > 0n) addDelta(buyer, tokensOut);
    } else if (row.event_name === 'Sold') {
      const seller = (args as any).seller ?? (args as any)[0];
      const tokensInRaw = (args as any).tokensIn ?? (args as any)[1];
      const tokensIn = toBigIntSafe(tokensInRaw);
      if (tokensIn > 0n) addDelta(seller, -tokensIn);
    }
  }

  const SCALE = 10000n; // 2 ondalık hassasiyet
  const calcPct = (amount: bigint): number => {
    if (amount <= 0n || totalSupply <= 0n) return 0;
    const scaled = (amount * SCALE) / totalSupply;
    const pct = Number(scaled) / 100;
    if (!Number.isFinite(pct)) return 0;
    return Math.max(0, Math.min(100, pct));
  };

  const holders: TopHolderRow[] = [];

  const bondingPct = calcPct(contractTokenBalance);
  if (bondingPct > 0) {
    holders.push({
      address: contract,
      percentage: bondingPct,
      tag: 'Bonding Pool Tokens',
      is_contract: true,
    });
  }

  const walletEntries = Array.from(balances.entries())
    .filter(([addr, balance]) => balance > 0n && addr !== contract)
    .sort((a, b) => {
      if (a[1] === b[1]) return 0;
      return a[1] > b[1] ? -1 : 1;
    });

  for (const [addr, balance] of walletEntries.slice(0, limit)) {
    const pct = calcPct(balance);
    if (pct <= 0) continue;
    holders.push({
      address: addr,
      percentage: pct,
      is_contract: false,
    });
  }

  if (!holders.length) {
    return null;
  }

  return holders;
}

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
      // 1) Holder sayısını project_events tablosundan hesapla (benzersiz buyer adresleri)
      let holdersCount = m.holdersCount ?? 0;
      try {
        const { rows } = await db.query<{ holders: string }>(
          `SELECT COALESCE(COUNT(DISTINCT COALESCE(
              event_data->'args'->>'buyer',
              event_data->'args'->>0
            )), 0)::text AS holders
           FROM project_events
           WHERE contract_address = $1
             AND event_name = 'Invested'`,
          [m.contractAddress.toLowerCase()]
        );
        if (rows[0]?.holders) {
          const parsed = Number(rows[0].holders);
          if (Number.isFinite(parsed)) holdersCount = parsed;
        }
      } catch (e) {
        console.error(`[METRICS-HOLDERS-ERROR] ${m.contractAddress}:`, e);
      }

      // 2) Son 24 saatin hacmini hesapla (Invested.amountIn + Sold.amountOut)
      let volume24h = m.volume24h ?? '0';
      try {
        const { rows } = await db.query<{ event_name: string; event_data: any }>(
          `SELECT event_name, event_data
             FROM project_events
            WHERE contract_address = $1
              AND event_name IN ('Invested', 'Sold')
              AND created_at >= NOW() - INTERVAL '24 hours'`,
          [m.contractAddress.toLowerCase()]
        );

        let volume = 0n;
        for (const row of rows) {
          const data = row.event_data as any;
          const args = data?.args ?? {};
          let raw: any;

          if (row.event_name === 'Invested') {
            raw = (args as any).amountIn ?? (args as any)[1];
          } else if (row.event_name === 'Sold') {
            raw = (args as any).amountOut ?? (args as any)[2];
          }

          if (raw == null) continue;

          try {
            let v: bigint;
            if (typeof raw === 'bigint') {
              v = raw;
            } else if (typeof raw === 'number') {
              v = BigInt(raw);
            } else if (typeof raw === 'string') {
              // Destek: hem decimal string hem 0x hex string
              v = raw.startsWith('0x') || raw.startsWith('0X') ? BigInt(raw) : BigInt(raw);
            } else {
              continue;
            }
            volume += v;
          } catch {
            // Bu satır hatalıysa, sadece o event'i atla
            continue;
          }
        }

        volume24h = volume.toString();
      } catch (e) {
        console.error(`[METRICS-VOLUME24H-ERROR] ${m.contractAddress}:`, e);
      }

      // 3) DB güncellemesi
      await db.query(
        `UPDATE projects
           SET total_raised = $1,
               market_cap = $2,
               holders_count = $3,
               volume_24h = $4,
               price_change_24h = $5,
               final_target_wei = CASE
                 WHEN final_target_wei IS NULL OR final_target_wei = 0 THEN $6
                 ELSE final_target_wei
               END,
               last_interaction_timestamp = NOW()
         WHERE contract_address = $7`,
        [
          m.totalRaised,
          m.marketCap,
          holdersCount,
          volume24h,
          m.priceChange24h,
          (m as any).finalTargetWei ?? null,
          m.contractAddress,
        ]
      );

      // 3b) Top holders (bonding pool + cüzdanlar) snapshot'ı
      try {
        const topHolders = await computeTopHolders(
          db,
          m.contractAddress,
          (m as any).totalSupply,
          (m as any).contractTokenBalance,
          50
        );
        if (topHolders && topHolders.length > 0) {
          await db.query(
            `UPDATE projects
               SET top_holders = $1
             WHERE contract_address = $2`,
            [JSON.stringify(topHolders), m.contractAddress.toLowerCase()]
          );
        }
      } catch (e) {
        // Kolon eksik veya sorgu hatası durumunda metrik cron'unu kırma
        console.error(`[METRICS-TOP-HOLDERS-ERROR] ${m.contractAddress}:`, e);
      }

      // 2) KV: Saatlik fiyat snapshot yazımı
      const now = new Date();
      const hourKey = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}`;
      const snapKey = `prices:${m.chainId}:${m.contractAddress.toLowerCase()}:${hourKey}`;
      const snapVal = JSON.stringify({ price: m.currentPrice, ts: now.toISOString() });
      // ~8 gün TTL
      await cache.set(snapKey, snapVal, 60 * 60 * 24 * 40);

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
      const price1h = await getSnapshotPrice(1);
      const price2h = await getSnapshotPrice(2);
      const price1w = await getSnapshotPrice(24 * 7);
      const price30d = await getSnapshotPrice(24 * 30);

      const pct = (prev: bigint | null): number => {
        if (!prev || prev === 0n) return 0;
        const diff = Number(curPrice - prev);
        return (diff / Number(prev)) * 100;
      };

      const pc1h = pct(price1h);
      const pc2h = pct(price2h);
      const pc1w = pct(price1w);
      const pc30d = pct(price30d);

      // 4) Sidecar değişim kayıtları
      const sidecarKey = `pchange:${m.contractAddress.toLowerCase()}`;
      await cache.set(sidecarKey, { pc1h, pc2h, pc1w, pc30d, updatedAt: now.toISOString() }, 60 * 10);
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

import { Hono } from 'hono';
import type { AppHono } from '../types.js';
import { KVNamespace } from '@cloudflare/workers-types';
import { NeonQueryFunction } from '@neondatabase/serverless';

const ranking = new Hono() as AppHono;

const fetchRankedProjects = async (
    db: NeonQueryFunction,
    cache: KVNamespace,
    sortBy: 'market_cap' | 'volume_24h',
    options: { chainId?: number; limit: number }
) => {
    const { chainId, limit } = options;
    const cacheKey = `ranking:${sortBy}:chain:${chainId ?? 'all'}:limit:${limit}:v8`;
    const cached = await cache.get(cacheKey, { type: 'json' });
    if (cached) return cached;

    // ✅ FIXED: Use different queries based on sortBy instead of db.raw()
    let projects;
    try {
        if (sortBy === 'market_cap') {
            if (typeof chainId === 'number') {
                projects = await db`
                    SELECT contract_address, current_name, current_symbol, current_logo_url,
                           chain_id, chain_name, price_change_24h, market_cap, volume_24h
                    FROM projects
                    WHERE is_finalized = false AND chain_id = ${chainId}
                    ORDER BY market_cap DESC NULLS LAST
                    LIMIT ${limit}
                `;
            } else {
                projects = await db`
                    SELECT contract_address, current_name, current_symbol, current_logo_url,
                           chain_id, chain_name, price_change_24h, market_cap, volume_24h
                    FROM projects
                    WHERE is_finalized = false
                    ORDER BY market_cap DESC NULLS LAST
                    LIMIT ${limit}
                `;
            }
        } else {
            if (typeof chainId === 'number') {
                projects = await db`
                    SELECT contract_address, current_name, current_symbol, current_logo_url,
                           chain_id, chain_name, price_change_24h, market_cap, volume_24h
                    FROM projects
                    WHERE is_finalized = false AND chain_id = ${chainId}
                    ORDER BY volume_24h DESC NULLS LAST
                    LIMIT ${limit}
                `;
            } else {
                projects = await db`
                    SELECT contract_address, current_name, current_symbol, current_logo_url,
                           chain_id, chain_name, price_change_24h, market_cap, volume_24h
                    FROM projects
                    WHERE is_finalized = false
                    ORDER BY volume_24h DESC NULLS LAST
                    LIMIT ${limit}
                `;
            }
        }
        await cache.put(cacheKey, JSON.stringify(projects), { expirationTtl: 60 });
        return projects;
    } catch (err) {
        // Fallback to last cached snapshot if query fails
        const stale = await cache.get(cacheKey, { type: 'json' });
        if (stale) return stale;
        throw err;
    }
};

ranking.get('/', async (c) => {
    const db = c.get('db');
    const cache = c.env.KV_CACHE;

    try {
        const limitParam = Number(c.req.query('limit') || '50');
        const chainIdParam = c.req.query('chainId');
        const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(100, limitParam)) : 50;
        const chainId = chainIdParam ? Number(chainIdParam) : undefined;

        const [marketCapRanking, volumeRanking] = await Promise.all([
            fetchRankedProjects(db, cache, 'market_cap', { chainId, limit }),
            fetchRankedProjects(db, cache, 'volume_24h', { chainId, limit })
        ]);

        return c.json({ success: true, marketCapRanking, volumeRanking });
    } catch (e: any) {
        console.error('[API-RANKING-ERROR]', e);
        return c.json({ success: false, error: 'Ranking data could not be loaded.' }, 500);
    }
});

export default ranking;


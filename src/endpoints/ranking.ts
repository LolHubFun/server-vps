import { Hono } from 'hono';
import type { Pool } from 'pg';
import type { AppHono } from '../types.js';
import type { CacheService } from '../cache.service.js';

const ranking = new Hono() as AppHono;

const fetchRankedProjects = async (
    db: Pool,
    cache: CacheService,
    sortBy: 'market_cap' | 'volume_24h',
    options: { chainId?: number; limit: number }
) => {
    const { chainId, limit } = options;
    const cacheKey = `ranking:${sortBy}:chain:${chainId ?? 'all'}:limit:${limit}:v8`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    // ✅ FIXED: Use different queries based on sortBy instead of db.raw()
    let projects;
    try {
        if (sortBy === 'market_cap') {
            if (typeof chainId === 'number') {
                const result = await db.query(
                    `SELECT contract_address, current_name, current_symbol, current_logo_url,
                            chain_id, chain_name, price_change_24h, market_cap, volume_24h
                     FROM projects
                     WHERE is_finalized = false AND chain_id = $1
                     ORDER BY market_cap DESC NULLS LAST
                     LIMIT $2`,
                    [chainId, limit]
                );
                projects = result.rows;
            } else {
                const result = await db.query(
                    `SELECT contract_address, current_name, current_symbol, current_logo_url,
                            chain_id, chain_name, price_change_24h, market_cap, volume_24h
                     FROM projects
                     WHERE is_finalized = false
                     ORDER BY market_cap DESC NULLS LAST
                     LIMIT $1`,
                    [limit]
                );
                projects = result.rows;
            }
        } else {
            if (typeof chainId === 'number') {
                const result = await db.query(
                    `SELECT contract_address, current_name, current_symbol, current_logo_url,
                            chain_id, chain_name, price_change_24h, market_cap, volume_24h
                     FROM projects
                     WHERE is_finalized = false AND chain_id = $1
                     ORDER BY volume_24h DESC NULLS LAST
                     LIMIT $2`,
                    [chainId, limit]
                );
                projects = result.rows;
            } else {
                const result = await db.query(
                    `SELECT contract_address, current_name, current_symbol, current_logo_url,
                            chain_id, chain_name, price_change_24h, market_cap, volume_24h
                     FROM projects
                     WHERE is_finalized = false
                     ORDER BY volume_24h DESC NULLS LAST
                     LIMIT $1`,
                    [limit]
                );
                projects = result.rows;
            }
        }
        await cache.set(cacheKey, projects, 60);
        return projects;
    } catch (err) {
        // Fallback to last cached snapshot if query fails
        const stale = await cache.get(cacheKey);
        if (stale) return stale;
        throw err;
    }
};

ranking.get('/', async (c) => {
    const db = c.get('db');
    const cache = c.get('cache');

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


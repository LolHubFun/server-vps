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

const parseWindow = (value: string | null | undefined): '1h' | '24h' | '7d' | '30d' => {
    if (!value) return '24h';
    const v = value.toLowerCase();
    if (v === '1h') return '1h';
    if (v === '7d') return '7d';
    if (v === '30d' || v === '30day' || v === '30days') return '30d';
    return '24h';
};

const fetchTopMovers = async (
    db: Pool,
    cache: CacheService,
    window: '1h' | '24h' | '7d' | '30d',
    options: { chainId?: number; limit: number }
) => {
    const { chainId, limit } = options;
    const safeLimit = Math.max(1, Math.min(100, limit));
    const cacheKey = `ranking:movers:${window}:chain:${chainId ?? 'all'}:limit:${safeLimit}:v1`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const baseParams: any[] = [];
    let where = 'is_finalized = false';
    if (typeof chainId === 'number') {
        baseParams.push(chainId);
        where += ` AND chain_id = $${baseParams.length}`;
    }

    const select = `contract_address, current_name, current_symbol, current_logo_url,
                    chain_id, chain_name, price_change_24h, market_cap, volume_24h`;

    // Aşırı yükü engellemek için maksimum aday sayısını sınırlayalım
    const candidateLimit = Math.max(safeLimit * 4, 50);
    const result = await db.query(
        `SELECT ${select}
         FROM projects
         WHERE ${where}
         ORDER BY market_cap DESC NULLS LAST
         LIMIT $${baseParams.length + 1}`,
        [...baseParams, candidateLimit]
    );

    type Row = {
        contract_address: string;
        current_name: string | null;
        current_symbol: string | null;
        current_logo_url: string | null;
        chain_id?: number;
        chain_name?: string;
        price_change_24h?: number | string | null;
        market_cap: string;
        volume_24h: string;
    };

    const rows = result.rows as Row[];

    const withChange = await Promise.all(
        rows.map(async (p) => {
            let change = 0;
            if (window === '24h') {
                const raw = p.price_change_24h;
                if (typeof raw === 'number') change = raw;
                else if (typeof raw === 'string') {
                    const parsed = Number(raw);
                    if (Number.isFinite(parsed)) change = parsed;
                }
            } else {
                try {
                    const sidecar = await cache.get<{ pc1h?: number; pc1w?: number; pc30d?: number }>(
                        `pchange:${p.contract_address.toLowerCase()}`
                    );
                    if (sidecar) {
                        if (window === '1h') change = sidecar.pc1h ?? 0;
                        else if (window === '7d') change = sidecar.pc1w ?? 0;
                        else if (window === '30d') change = sidecar.pc30d ?? 0;
                    }
                } catch {
                    // ignore cache errors, fall back to 0
                }
            }
            return { ...p, change };
        })
    );

    // Sıralama: gainers için azalan, losers için artan
    const sortedDesc = [...withChange].sort((a, b) => b.change - a.change);
    const gainers = sortedDesc.slice(0, safeLimit);

    const sortedAsc = [...withChange].sort((a, b) => a.change - b.change);
    const losers = sortedAsc.slice(0, safeLimit);

    const payload = { gainers, losers, window };
    await cache.set(cacheKey, payload, 60);
    return payload;
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

ranking.get('/movers', async (c) => {
    const db = c.get('db');
    const cache = c.get('cache');

    try {
        const windowParam = c.req.query('window');
        const limitParam = Number(c.req.query('limit') || '30');
        const chainIdParam = c.req.query('chainId');

        const window = parseWindow(windowParam);
        const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(100, limitParam)) : 30;
        const chainId = chainIdParam ? Number(chainIdParam) : undefined;

        const data = await fetchTopMovers(db, cache, window, { chainId, limit });
        return c.json({ success: true, ...data });
    } catch (e: any) {
        console.error('[API-RANKING-MOVERS-ERROR]', e);
        return c.json({ success: false, error: 'Top movers data could not be loaded.' }, 500);
    }
});

export default ranking;

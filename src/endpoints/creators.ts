import { Hono } from 'hono';
import type { AppHono } from '../types.js';

const creators = new Hono() as AppHono;

// 1. CREATOR İSTATİSTİKLERİ
creators.get('/:address/stats', async (c) => {
    const db = c.get('db');
    const cache = c.get('cache');
    const address = c.req.param('address').toLowerCase();
    
    const cacheKey = `creator:stats:${address}`;
    const cached = await cache.get(cacheKey);
    if (cached) return c.json({ success: true, stats: cached });

    try {
        const result = await db.query(
            `SELECT 
                COUNT(*) as created_count, 
                COALESCE(SUM(total_raised), 0) as total_raised_wei,
                MAX(created_at) as last_active
             FROM projects 
             WHERE creator_address = $1`,
            [address]
        );

        const stats = result.rows[0];
        await cache.set(cacheKey, stats, 300); // 5 dk cache
        
        return c.json({ success: true, stats });
    } catch (e) {
        console.error('[CREATOR-STATS-ERROR]', e);
        return c.json({ success: false, error: 'İstatistikler alınamadı.' }, 500);
    }
});

// 2. YARATILAN PROJELER LİSTESİ
creators.get('/:address/created', async (c) => {
    const db = c.get('db');
    const address = c.req.param('address').toLowerCase();
    const pageParam = Number(c.req.query('page') || '1');
    const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    try {
        const result = await db.query(
            `SELECT 
                contract_address, current_name, current_symbol, current_logo_url, 
                market_cap, price_change_24h, is_finalized, chain_name, created_at, evolution_mode
             FROM projects
             WHERE creator_address = $1
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [address, limit, offset]
        );

        return c.json({ success: true, projects: result.rows, hasMore: result.rows.length === limit });
    } catch (e) {
        console.error('[CREATOR-PROJECTS-ERROR]', e);
        return c.json({ success: false, error: 'Projeler alınamadı.' }, 500);
    }
});

export default creators;

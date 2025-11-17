import { Hono } from 'hono';
import type { AppHono } from '../types.js';

const home = new Hono() as AppHono;

home.get('/sections', async (c) => {
    const db = c.get('db');
    const cache = c.get('cache');
    const cacheKey = 'home:sections:v6';

    try {
        const cached = await cache.get(cacheKey);
        if (cached) return c.json({ success: true, sections: cached });

        const select = `contract_address, current_name, current_logo_url, creator_address,
                        created_at, market_cap, price_change_24h, live_stream_url,
                        evolution_mode, total_raised`;

        const [newlyCreated, aboutToLaunch, hot, graduated] = await Promise.all([
            db.query(`SELECT ${select} FROM projects WHERE is_finalized = false ORDER BY created_at DESC LIMIT 10`).then(r => r.rows),
            db.query(`SELECT ${select} FROM projects WHERE is_finalized = false AND total_raised > 0 ORDER BY total_raised DESC NULLS LAST LIMIT 10`).then(r => r.rows),
            db.query(`SELECT ${select} FROM projects WHERE is_finalized = false ORDER BY volume_24h DESC NULLS LAST LIMIT 10`).then(r => r.rows),
            db.query(`SELECT ${select} FROM projects WHERE is_finalized = true ORDER BY updated_at DESC LIMIT 10`).then(r => r.rows),
        ]);

        const sections = { newlyCreated, aboutToLaunch, hot, graduated };
        await cache.set(cacheKey, sections, 60);

        return c.json({ success: true, sections });
    } catch (e: any) {
        console.error('[API-HOME-SECTIONS-ERROR]', e);
        return c.json({ success: false, error: 'Home page data could not be loaded.' }, 500);
    }
});

export default home;


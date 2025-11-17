// src/index.ts - NİHAİ VE TAM HALİ
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import cron from 'node-cron';
import fileUpload from 'express-fileupload';
import 'dotenv/config';

import type { AppHono, Env } from './types.js';
import projectEndpoints from './endpoints/projects.js';
import rankingEndpoints from './endpoints/ranking.js';
import homeEndpoints from './endpoints/home.js';
import { updateAllProjectMetrics } from './scheduled-tasks/update-metrics.js';
import { pollForTokenCreatedEvents } from './blockchain-listener.js';
import { CacheService } from './cache.service.js';

const app: AppHono = new Hono();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('connect', () => console.log('[DB] Connected to PostgreSQL.'));
pool.on('error', (err) => console.error('[DB-ERROR]', err));

const env = process.env as unknown as Env;
const cache = new CacheService();

const allowedOrigins = ['http://localhost:3000', 'https://lolhub.fun', 'https://lolhubfun.pages.dev'];
app.use('*', cors({ origin: (origin) => (origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0]) }));

// Hono'nun express-fileupload ile uyumlu çalışması için bu şekilde ekliyoruz
app.use('*', async (c, next) => {
    await new Promise<void>((resolve, reject) => {
        fileUpload()(c.req.raw as any, c.res as any, (err?: any) => {
            if (err) reject(err);
            else resolve();
        });
    });
    await next();
});

app.use('*', async (c, next) => {
    c.set('db', pool);
    c.set('cache', cache);
    c.set('env', env);
    await next();
});

app.use('/uploads/*', serveStatic({ root: './' }));

app.get('/health', async (c) => {
    try {
        await pool.query('SELECT 1');
        return c.json({ status: 'ok' });
    } catch (error) {
        console.error('[HEALTH-ERROR]', error);
        return c.json({ status: 'error' }, 500);
    }
});

app.route('/api/projects', projectEndpoints);
app.route('/api/ranking', rankingEndpoints);
app.route('/api/home', homeEndpoints);

cron.schedule('*/5 * * * *', async () => {
    await updateAllProjectMetrics(pool, cache, env);
});
cron.schedule('*/15 * * * * *', async () => {
    await pollForTokenCreatedEvents(pool, cache, env);
});

const port = Number(process.env.PORT) || 3001;
serve({ fetch: app.fetch, port }, (info) => {
    console.log(`✅ Server is running at http://localhost:${info.port}`);
});

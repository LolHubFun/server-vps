// src/index.ts - NODE.JS SUNUCUSU İÇİN NİHAİ VERSİYON

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import cron from 'node-cron';
import 'dotenv/config';

import type { AppHono } from './types.js';
import projectEndpoints from './endpoints/projects.js';
import rankingEndpoints from './endpoints/ranking.js';
import homeEndpoints from './endpoints/home.js';
import { updateAllProjectMetrics } from './scheduled-tasks/update-metrics.js';
import { runConsistencyCheck } from './event-listener.js';
import { pollForTokenCreatedEvents } from './blockchain-listener.js';
import { dbClient, pool } from './db.js';
import { appConfig } from './config.js';

const app: AppHono = new Hono();

app.use('*', cors({ origin: '*' }));
app.use('*', async (c, next) => {
    c.set('db', dbClient);
    try {
        await next();
    } catch (e) {
        console.error('[DB-MIDDLEWARE-ERROR]', e);
        return c.json({ success: false, error: 'Database connection error.' }, 500);
    }
});

// Logo/resim gibi statik dosyaları sunmak için
app.use('/uploads/*', serveStatic({ root: './' }))

// --- API Rotaları ---
app.route('/api/projects', projectEndpoints);
app.route('/api/ranking', rankingEndpoints);
app.route('/api/home', homeEndpoints);

cron.schedule('*/10 * * * *', () => {
    console.log('[CRON] Running: updateAllProjectMetrics');
    updateAllProjectMetrics(dbClient, appConfig);
});

cron.schedule('0 */6 * * *', () => {
    console.log('[CRON] Running: runConsistencyCheck');
    runConsistencyCheck(appConfig, dbClient);
});

cron.schedule('*/15 * * * * *', () => {
    pollForTokenCreatedEvents(dbClient, appConfig);
});

// --- Sunucuyu Başlat ---
const port = Number(process.env.PORT || 3001);
console.log(`✅ Backend server is running on port ${port}`);

serve({ fetch: app.fetch, port });

pool.on('connect', () => console.log('[DB-POOL] Connected to PostgreSQL.'));


// src/index.ts - image-size TAMAMEN KALDIRILMIŞ NİHAİ VERSİYON
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import cron from 'node-cron';
import 'dotenv/config';

// DİKKAT: 'image-size' import'u tamamen kaldırıldı.

import type { AppHono, Env } from './types.js';
import projectEndpoints from './endpoints/projects.js';
import rankingEndpoints from './endpoints/ranking.js';
import homeEndpoints from './endpoints/home.js';
import { updateAllProjectMetrics } from './scheduled-tasks/update-metrics.js';
import { pollForTokenCreatedEvents } from './blockchain-listener.js';
import { CacheService } from './cache.service.js';
import { uploadLogoToServer } from './storage.service.js';

const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB
// const MAX_LOGO_DIMENSION = 512; // Bu kontrolü geçici olarak devre dışı bıraktık

const app: AppHono = new Hono();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('connect', () => console.log('[DB] Connected to PostgreSQL.'));
pool.on('error', (err) => console.error('[DB-ERROR]', err));

const env = process.env as unknown as Env;
const cache = new CacheService();

const allowedOrigins = ['http://localhost:3000', 'https://rusakh.online', 'https://lolhubfun.pages.dev'];
app.use('*', cors({ origin: allowedOrigins }));

app.use('*', async (c, next) => {
    c.set('db', pool);
    c.set('cache', cache);
    c.set('env', env);
    await next();
});

app.use('/uploads/*', serveStatic({ root: './' }));
app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/api/upload-logo', async (c) => {
    try {
        const body = await c.req.parseBody();
        const turnstileToken = body['turnstileToken'] as string | undefined;
        const logoFile = body['logo'] as File | undefined;

        if (!turnstileToken) return c.json({ success: false, error: 'Turnstile doğrulaması gerekli.' }, 400);
        const turnstileSecret = process.env.TURNSTILE_SECRET;
        if (!turnstileSecret) return c.json({ success: false, error: 'Sunucu yapılandırma hatası.' }, 500);
        if (!logoFile || !(logoFile instanceof File)) return c.json({ success: false, error: 'Logo dosyası yüklenmedi.' }, 400);
        if (logoFile.size > MAX_LOGO_BYTES) return c.json({ success: false, error: `Logo maksimum ${MAX_LOGO_BYTES / 1024 / 1024}MB olabilir.` }, 400);
        const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/jpg'];
        if (!allowedTypes.includes(logoFile.type)) return c.json({ success: false, error: 'Sadece PNG, JPG/JPEG veya GIF formatı desteklenir.' }, 400);

        const logoBuffer = Buffer.from(await logoFile.arrayBuffer());

        // ⭐⭐⭐ DİKKAT: image-size ile ilgili tüm 'try-catch' bloğu kaldırıldı. ⭐⭐⭐

        const form = new URLSearchParams();
        form.append('secret', turnstileSecret);
        form.append('response', turnstileToken);
        const ip = c.req.header('CF-Connecting-IP') || c.req.header('x-forwarded-for') || '';
        if (ip) form.append('remoteip', ip);

        const verifyResp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
        const verifyData = await verifyResp.json() as { success: boolean };
        if (!verifyData.success) return c.json({ success: false, error: 'Turnstile doğrulaması başarısız. Lütfen tekrar deneyin.' }, 403);

        const identifierSource: string = (body['identifier'] as string) || logoFile.name || 'logo';
        const extension = (logoFile.type.split('/')[1] || 'png') as 'png' | 'jpg' | 'gif';
        const url = await uploadLogoToServer(logoBuffer, { identifier: identifierSource, extension });

        c.header('Cache-Control', 'no-store');
        return c.json({ success: true, url });
    } catch (error) {
        console.error('[API-UPLOAD-LOGO-ERROR]', error);
        return c.json({ success: false, error: 'Logo yüklenirken beklenmedik bir hata oluştu.' }, 500);
    }
});

app.route('/api/projects', projectEndpoints);
app.route('/api/ranking', rankingEndpoints);
app.route('/api/home', homeEndpoints);

cron.schedule('*/5 * * * *', () => { updateAllProjectMetrics(pool, cache, env); });
cron.schedule('*/15 * * * * *', () => { pollForTokenCreatedEvents(pool, cache, env); });

const port = Number(process.env.PORT) || 3001;
serve({ fetch: app.fetch, port }, (info) => {
    console.log(`✅ Server is running at http://localhost:${info.port}`);
});

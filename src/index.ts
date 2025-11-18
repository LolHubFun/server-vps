// src/index.ts - NİHAİ VE TAM HALİ
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import cron from 'node-cron';
import fileUpload from 'express-fileupload';
import type { UploadedFile } from 'express-fileupload';
import { imageSize } from 'image-size';
import 'dotenv/config';

import type { AppHono, Env } from './types.js';
import projectEndpoints from './endpoints/projects.js';
import rankingEndpoints from './endpoints/ranking.js';
import homeEndpoints from './endpoints/home.js';
import { updateAllProjectMetrics } from './scheduled-tasks/update-metrics.js';
import { pollForTokenCreatedEvents } from './blockchain-listener.js';
import { CacheService } from './cache.service.js';
import { uploadLogoToServer } from './storage.service.js';

const MAX_LOGO_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_LOGO_DIMENSION = 26; // 26px x 26px

const app: AppHono = new Hono();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('connect', () => console.log('[DB] Connected to PostgreSQL.'));
pool.on('error', (err) => console.error('[DB-ERROR]', err));

const env = process.env as unknown as Env;
const cache = new CacheService();

const allowedOrigins = ['http://localhost:3000', 'https://rusakh.online', 'https://lolhubfun.pages.dev'];
app.use('*', cors({ origin: allowedOrigins }));

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

app.post('/api/upload-logo', async (c) => {
    try {
        const rawReq = c.req.raw as any;
        const files = rawReq.files as Record<string, UploadedFile | UploadedFile[]> | undefined;
        const body = rawReq.body || {};
        const turnstileToken = body.turnstileToken;

        if (!turnstileToken) {
            return c.json({ success: false, error: 'Turnstile doğrulaması gerekli.' }, 400);
        }

        const turnstileSecret = process.env.TURNSTILE_SECRET;
        if (!turnstileSecret) {
            console.error('[UPLOAD-LOGO] TURNSTILE_SECRET missing in environment');
            return c.json({ success: false, error: 'Sunucu yapılandırma hatası.' }, 500);
        }

        const logoRaw = files?.logo;
        const logoFile = Array.isArray(logoRaw) ? logoRaw[0] : logoRaw;
        if (!logoFile) {
            return c.json({ success: false, error: 'Logo dosyası yüklenmedi.' }, 400);
        }

        if (logoFile.size > MAX_LOGO_BYTES) {
            return c.json({ success: false, error: 'Logo maksimum 1 MB olabilir.' }, 400);
        }

        const allowedTypes = ['image/png', 'image/jpeg'];
        if (!allowedTypes.includes(logoFile.mimetype)) {
            return c.json({ success: false, error: 'Sadece PNG veya JPG formatı desteklenir.' }, 400);
        }

        let dimensions;
        try {
            dimensions = imageSize(logoFile.data);
        } catch (err) {
            console.warn('[UPLOAD-LOGO] image-size failed:', err);
            return c.json({ success: false, error: 'Geçersiz logo dosyası.' }, 400);
        }

        const width = dimensions.width || 0;
        const height = dimensions.height || 0;
        if (width > MAX_LOGO_DIMENSION || height > MAX_LOGO_DIMENSION) {
            return c.json({ success: false, error: 'Logo boyutu en fazla 26x26 piksel olabilir.' }, 400);
        }

        const form = new URLSearchParams();
        form.append('secret', turnstileSecret);
        form.append('response', turnstileToken);
        const ip = c.req.header('CF-Connecting-IP') || c.req.header('x-forwarded-for') || '';
        if (ip) form.append('remoteip', ip);

        const verifyResp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            body: form
        });
        const verifyData = await verifyResp.json() as { success: boolean };
        if (!verifyData.success) {
            return c.json({ success: false, error: 'Turnstile doğrulaması başarısız.' }, 403);
        }

        const identifierSource: string = body.projectAddress || body.identifier || logoFile.name || 'logo';
        const extension = logoFile.mimetype === 'image/png' ? 'png' : 'jpg';
        const url = await uploadLogoToServer(logoFile.data, { identifier: identifierSource, extension });

        c.header('Cache-Control', 'no-store');
        return c.json({ success: true, url });
    } catch (error) {
        console.error('[API-UPLOAD-LOGO-ERROR]', error);
        return c.json({ success: false, error: 'Logo yüklenirken bir hata oluştu.' }, 500);
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

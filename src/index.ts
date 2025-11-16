// src/index.ts - YENİ VPS MİMARİSİ İÇİN NİHAİ VE TAM VERSİYON

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import cron from 'node-cron';
import 'dotenv/config'; // .env dosyasını en üstte yükle

// Kendi oluşturduğumuz modülleri import ediyoruz
import type { AppHono, Env } from './types.js';
import projectEndpoints from './endpoints/projects.js';
import rankingEndpoints from './endpoints/ranking.js';
import homeEndpoints from './endpoints/home.js';
import { updateAllProjectMetrics } from './scheduled-tasks/update-metrics.js';
import { pollForTokenCreatedEvents } from './blockchain-listener.js';
// runConsistencyCheck artık kullanılmıyor, yerine pollForTokenCreatedEvents geldi

const app: AppHono = new Hono();

// --- Veritabanı Bağlantısı ---
// Pool'u bir kere oluştur ve tüm uygulama boyunca kullan.
// Bu, bağlantıları verimli bir şekilde yönetir.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

pool.on('connect', () => console.log('[DB] Successfully connected to PostgreSQL.'));
pool.on('error', (err) => console.error('[DB-ERROR] Unexpected error on idle client', err));

// --- Middleware'ler ---

// 1. CORS (Cross-Origin Resource Sharing)
// Production için daha güvenli hale getirildi.
const allowedOrigins = [
    'http://localhost:3000', // Geliştirme için
    'https://lolhub.fun',
    'https://lolhubfun.pages.dev',
];
app.use('*', cors({
    origin: (origin) => (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]),
}));

// 2. Veritabanı Bağlantısını Context'e Ekleme
app.use('*', async (c, next) => {
    c.set('db', pool);
    try {
        await next();
    } catch (e: any) {
        console.error('[MIDDLEWARE-FATAL-ERROR]', e.message);
        return c.json({ success: false, error: "An unexpected server error occurred." }, 500);
    }
});

// 3. Statik Dosya Sunucusu (Logolar için)
// /uploads/logos/dosya.png -> ./uploads/logos/dosya.png
app.use('/uploads/*', serveStatic({ root: './' }));

// --- API Rotaları (Endpoints) ---
app.route('/api/projects', projectEndpoints);
app.route('/api/ranking', rankingEndpoints);
app.route('/api/home', homeEndpoints);

// --- Zamanlanmış Görevler (Cron Jobs) ---
// Not: `process.env`'i Env tipine cast ederek tip güvenliği sağlıyoruz.
const env = process.env as unknown as Env;

// Her 5 dakikada bir proje metriklerini güncelle
cron.schedule('*/5 * * * *', () => {
    console.log('[CRON] Running: updateAllProjectMetrics');
    updateAllProjectMetrics(pool, env);
});

// Her 15 saniyede bir yeni yaratılan token'ları kontrol et
cron.schedule('*/15 * * * * *', () => {
  pollForTokenCreatedEvents(pool, env);
});

// --- Sunucuyu Başlatma ---
const port = Number(process.env.PORT) || 3001;
console.log(`✅ Backend server is running on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port: port,
});

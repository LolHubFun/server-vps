// packages/worker/src/endpoints/projects.ts - REPLY FUNKSİYASI İLƏ NİHAİ VERSİYA

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppHono } from '../types.js';
import { createPublicClient, http } from 'viem';
import { recoverMessageAddress } from 'viem/utils';
import { polygonAmoy } from 'viem/chains';
import type { Pool } from 'pg';

const ERC20_BALANCE_OF_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const;

const projects = new Hono() as AppHono;

// --- SCHEMALAR ---
const projectListQuerySchema = z.object({
  page: z.string().optional().default('1').transform(Number),
  limit: z.string().optional().default('21').transform(Number),
  sortBy: z.enum(['new', 'hot', 'graduated']).optional().default('new'),
  mode: z.enum(['all', 'standard', 'democracy', 'chaos']).optional().default('all'),
});

const commentSchema = z.object({
    userAddress: z.string().startsWith('0x'),
    commentText: z.string().min(3).max(500),
    parentCommentId: z.string().uuid().optional(), // <-- REPLY ÜÇÜN ƏLAVƏ EDİLDİ
    turnstileToken: z.string().min(5),
});

const liveStreamSchema = z.object({
  liveStreamUrl: z.string().url().refine((url) => {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      return host.includes('youtube.com') || host.includes('youtu.be') || host.includes('twitch.tv');
    } catch {
      return false;
    }
  }, { message: 'Only YouTube or Twitch links are allowed.' }),
  signature: z.string(),
  message: z.string(),
  turnstileToken: z.string().min(5),
});

// =================== PROYEKT LİSTƏSİ ===================
projects.get('/', zValidator('query', projectListQuerySchema), async (c) => {
    const db = c.get('db') as Pool;
    const cache = c.get('cache');
    const { page, limit, sortBy, mode } = c.req.valid('query');
    const isDynamicMode = mode === 'democracy' || mode === 'chaos';
    const cacheKey = `projects:list:v16:p${page}:l${limit}:s${sortBy}:m${mode}`;

    try {
        const ip = c.req.header('CF-Connecting-IP') || c.req.header('x-forwarded-for') || 'unknown';
        const now = new Date();
        const minuteKey = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;
        const rateKey = `rl:projects:${ip}:${minuteKey}`;
        const current = await cache.get<number>(rateKey);
        const count = (current || 0) + 1;
        if (count > 120) {
            c.header('Retry-After', '60');
            return c.json({ success: false, error: 'Rate limit exceeded' }, 429);
        }
        await cache.set(rateKey, count, 70);
    } catch {}

    try {
        const cachedData = await cache.get<any>(cacheKey);
        if (cachedData) {
            const sMaxAge = isDynamicMode ? 5 : 60;
            c.header('Cache-Control', `public, s-maxage=${sMaxAge}, stale-while-revalidate=300`);
            return c.json(cachedData);
        }

        const offset = (Math.max(1, page) - 1) * Math.min(100, limit);
        const isFinalized = sortBy === 'graduated';

        const whereClauses = ['is_finalized = $1'];
        const filterValues: (boolean | string)[] = [isFinalized];
        if (mode !== 'all') {
            whereClauses.push(`evolution_mode = $${filterValues.length + 1}`);
            filterValues.push(mode);
        }

        const buildOrderClause = () => {
            if (sortBy === 'hot') return 'ORDER BY volume_24h DESC NULLS LAST, created_at DESC';
            if (sortBy === 'graduated') return 'ORDER BY updated_at DESC';
            return 'ORDER BY created_at DESC';
        };

        const selectFields = `contract_address, creator_address, current_name, current_symbol, current_logo_url, created_at, market_cap, price_change_24h, live_stream_url, evolution_mode, chain_id, chain_name, volume_24h`;
        const whereSql = whereClauses.join(' AND ');
        const orderSql = buildOrderClause();

        const projectValues = [...filterValues, limit, offset];
        const limitIndex = filterValues.length + 1;
        const offsetIndex = filterValues.length + 2;
        const projectQuery = `
            SELECT ${selectFields}
            FROM projects
            WHERE ${whereSql}
            ${orderSql}
            LIMIT $${limitIndex}
            OFFSET $${offsetIndex}`;
        const [projectResult, totalResult] = await Promise.all([
            db.query(projectQuery, projectValues),
            db.query(`SELECT COUNT(*) FROM projects WHERE ${whereSql}`, filterValues)
        ]);

        const enriched = await Promise.all(projectResult.rows.map(async (p) => {
            const sidecar = await cache.get<{ pc2h: number; pc1w: number }>(`pchange:${p.contract_address.toLowerCase()}`);
            if (sidecar) {
                return { ...p, price_change_2h: sidecar.pc2h, price_change_1w: sidecar.pc1w };
            }
            return p;
        }));

        const totalProjects = totalResult.rows[0] ? Number(totalResult.rows[0].count) : 0;
        const totalPages = Math.ceil(totalProjects / limit);
        const responsePayload = { success: true, projects: enriched, pagination: { currentPage: page, totalPages, totalProjects, limit } };

        const sMaxAge = isDynamicMode ? 5 : 60;
        c.header('Cache-Control', `public, s-maxage=${sMaxAge}, stale-while-revalidate=300`);
        await cache.set(cacheKey, responsePayload, sMaxAge);
        return c.json(responsePayload);
    } catch (e: any) {
        console.error('[API-PROJECTS-ERROR]', e.message);
        return c.json({ success: false, error: 'Projeler yüklenemedi.' }, 500);
    }
});

// ⚠️ ÖNƏMLİ: Daha spesifik route-lar əvvəl olmalıdır, ümumi route-lar sonra!

// =================== BİR KOMMENTİN CAVABLARINI GƏTİRMƏK ===================
projects.get('/:address/comments/:commentId/replies', async (c) => {
    const db = c.get('db') as Pool;
    const cache = c.get('cache');
    const { commentId } = c.req.param();
    const cacheKey = `replies:v1:${commentId}`;
    try {
        const cached = await cache.get<any[]>(cacheKey);
        if (cached) return c.json({ success: true, replies: cached });

        const repliesResult = await db.query(
            `SELECT id, user_address, comment_text, created_at
             FROM comments
             WHERE parent_comment_id = $1
             ORDER BY created_at ASC
             LIMIT 100`,
            [commentId]
        );

        await cache.set(cacheKey, repliesResult.rows, 120);
        return c.json({ success: true, replies: repliesResult.rows });
    } catch (error) {
        console.error(`[API-REPLIES-ERROR] ${commentId}:`, error);
        return c.json({ success: false, error: 'Failed to fetch replies' }, 500);
    }
});

// =================== ANA KOMMENTLƏRİ GƏTİRMƏK ===================
projects.get('/:address/comments', async (c) => {
    const db = c.get('db') as Pool;
    const cache = c.get('cache');
    const projectAddress = c.req.param('address').toLowerCase();
    const cacheKey = `comments:v3:${projectAddress}`;
    try {
        const cached = await cache.get<any[]>(cacheKey);
        if (cached) return c.json({ success: true, comments: cached });

        const commentsResult = await db.query(
            `SELECT c.id, c.user_address, c.comment_text, c.created_at, COUNT(r.id) as reply_count
             FROM comments c
             LEFT JOIN comments r ON c.id = r.parent_comment_id
             WHERE c.project_contract_address = $1 AND c.parent_comment_id IS NULL
             GROUP BY c.id
             ORDER BY c.created_at DESC
             LIMIT 50`,
            [projectAddress]
        );

        await cache.set(cacheKey, commentsResult.rows, 120);
        return c.json({ success: true, comments: commentsResult.rows });
    } catch (error) {
        console.error(`[API-COMMENTS-ERROR] ${projectAddress}:`, error);
        return c.json({ success: false, error: 'Failed to fetch comments' }, 500);
    }
});

// =================== KOMMENT YAZMA (REPLY DƏSTƏYİ İLƏ) ===================
projects.post('/:address/comments', zValidator('json', commentSchema), async (c) => {
    const db = c.get('db') as Pool;
    const cache = c.get('cache');
    const projectAddress = c.req.param('address').toLowerCase();
    const { userAddress, commentText, parentCommentId, turnstileToken } = c.req.valid('json');
    const rateLimitKey = `comment_rl:${userAddress}:${projectAddress}`;

    const existingRate = await cache.get<string>(rateLimitKey);
    if (existingRate) return c.json({ success: false, error: 'Lütfen 60 saniye bekleyin.' }, 429);

    try {
        const rpcUrl = process.env.INFURA_AMOY_RPC_URL;
        if (!rpcUrl) {
            console.error('[COMMENT-RPC-ERROR] INFURA_AMOY_RPC_URL is not defined in environment');
            return c.json({ success: false, error: 'Sunucu yapılandırma hatası.' }, 500);
        }

        const client = createPublicClient({ chain: polygonAmoy, transport: http(rpcUrl) });
        const balance = await client.readContract({ address: projectAddress as `0x${string}`, abi: ERC20_BALANCE_OF_ABI, functionName: 'balanceOf', args: [userAddress as `0x${string}`] });
        if (balance === 0n) return c.json({ success: false, error: 'Yorum yapmak için bu projeden token sahibi olmalısınız.' }, 403);

        // --- TƏHLÜKƏSİZLİK: DƏRİNLİK LİMİTİ ---
        if (parentCommentId) {
            const parentComment = await db.query('SELECT parent_comment_id FROM comments WHERE id = $1', [parentCommentId]);
            const parentCount = parentComment.rowCount ?? 0;
            if (parentCount > 0 && parentComment.rows[0]?.parent_comment_id !== null) {
                return c.json({ success: false, error: 'Replies to replies are not allowed.' }, 403);
            }
        }

        const insertResult = await db.query(
            `INSERT INTO comments (project_contract_address, user_address, comment_text, parent_comment_id)
             VALUES ($1, $2, $3, $4)
             RETURNING id, user_address, comment_text, created_at`,
            [projectAddress, userAddress.toLowerCase(), commentText, parentCommentId || null]
        );

        await cache.set(rateLimitKey, '1', 60);
        await cache.delete(`comments:v3:${projectAddress}`);
        if (parentCommentId) {
            await cache.delete(`replies:v1:${parentCommentId}`);
        }

        return c.json({ success: true, comment: insertResult.rows[0] }, 201);
    } catch (error) {
        console.error('Comment submission failed:', error);
        return c.json({ success: false, error: 'Yorum gönderilemedi.' }, 500);
    }
});

// =================== CANLI YAYIN ===================
projects.post('/:address/set-live-stream', zValidator('json', liveStreamSchema), async (c) => {
    const db = c.get('db') as Pool;
    const cache = c.get('cache');
    const contractAddress = c.req.param('address').toLowerCase();
    const { liveStreamUrl, signature, message, turnstileToken } = c.req.valid('json');
    try {
        const turnstileSecret = process.env.TURNSTILE_SECRET;
        if (turnstileSecret) {
            const form = new URLSearchParams();
            form.append('secret', turnstileSecret);
            form.append('response', turnstileToken);
            const ip = c.req.header('CF-Connecting-IP') || '';
            if (ip) form.append('remoteip', ip);
            const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
            const data = await resp.json() as any;
            if (!data.success) return c.json({ success: false, error: 'Turnstile doğrulaması başarısız.' }, 403);
        }

        const signerAddress = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
        const projectResult = await db.query('SELECT creator_address FROM projects WHERE contract_address = $1', [contractAddress]);
        if (projectResult.rowCount === 0) return c.json({ success: false, error: 'Proje bulunamadı.' }, 404);
        const creatorAddress = projectResult.rows[0].creator_address;
        if (signerAddress.toLowerCase() !== creatorAddress.toLowerCase()) return c.json({ success: false, error: 'Yetkisiz işlem.' }, 403);
        await db.query('UPDATE projects SET live_stream_url = $1 WHERE contract_address = $2', [liveStreamUrl, contractAddress]);
        await cache.delete(`project:detail:v4:${contractAddress}`);
        return c.json({ success: true, message: 'Live stream URL updated.' });
    } catch (error: any) {
        console.error('[SET-LIVE-STREAM-ERROR]', error);
        return c.json({ success: false, error: 'İmza doğrulanamadı veya bir sunucu hatası oluştu.' }, 500);
    }
});

// =================== TEKİL PROYEKT DETAYI (ən sonuncu çünki ən ümumi route-dur) ===================
projects.get('/:address', async (c) => {
    const db = c.get('db') as Pool;
    const cache = c.get('cache');
    const address = c.req.param('address').toLowerCase();
    const cacheKey = `project:detail:v4:${address}`;
    try {
        const cachedProject = await cache.get<any>(cacheKey);
        if (cachedProject) return c.json({ success: true, project: cachedProject });
        const result = await db.query('SELECT * FROM projects WHERE contract_address = $1', [address]);
        if (result.rowCount === 0) return c.json({ success: false, error: 'Project not found' }, 404);
        const project = result.rows[0];
        await cache.set(cacheKey, project, 120);
        return c.json({ success: true, project });
    } catch (error) {
        console.error(`[API-PROJECT-DETAIL-ERROR] ${address}:`, error);
        return c.json({ success: false, error: 'Failed to fetch project' }, 500);
    }
});

export default projects;

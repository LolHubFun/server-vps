import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { verifyMessage } from 'viem';
import type { AppHono } from '../types.js';

const auth = new Hono() as AppHono;

// 1. NONCE OLUŞTURMA (Giriş İsteği)
auth.post('/nonce', zValidator('json', z.object({ address: z.string().min(10) })), async (c) => {
    const db = c.get('db');
    const { address } = c.req.valid('json');
    const lowerAddress = address.toLowerCase();

    // Rastgele kod üret
    const randomString = crypto.randomBytes(16).toString('hex');
    const nonceMessage = `Sign this message to login to Lolhub Fun.\n\nNonce: ${randomString}\nTimestamp: ${Date.now()}`;

    // DB'ye kaydet
    await db.query(
        `INSERT INTO wallet_nonces (address, nonce, expires_at, updated_at)
         VALUES ($1, $2, NOW() + INTERVAL '5 minutes', NOW())
         ON CONFLICT (address) DO UPDATE SET
            nonce = EXCLUDED.nonce,
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()`,
        [lowerAddress, nonceMessage]
    );

    return c.json({ success: true, nonce: nonceMessage });
});

// 2. İMZA DOĞRULAMA (Giriş Onayı)
auth.post('/verify', zValidator('json', z.object({ address: z.string(), signature: z.string() })), async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const { address, signature } = c.req.valid('json');
    const lowerAddress = address.toLowerCase();

    // DB'den nonce'u çek
    const result = await db.query(
        `SELECT nonce FROM wallet_nonces WHERE address = $1 AND expires_at > NOW()`,
        [lowerAddress]
    );

    if (result.rowCount === 0) {
        return c.json({ success: false, error: 'Oturum süresi dolmuş veya geçersiz.' }, 401);
    }

    const nonceMessage = result.rows[0].nonce;

    try {
        // İmzayı doğrula
        const isValid = await verifyMessage({
            address: lowerAddress as `0x${string}`,
            message: nonceMessage,
            signature: signature as `0x${string}`,
        });

        if (!isValid) {
            return c.json({ success: false, error: 'İmza geçersiz.' }, 401);
        }

        // Token oluştur
        const jwtSecret = env.JWT_SECRET || 'default-secret';
        const token = jwt.sign({ address: lowerAddress }, jwtSecret, { expiresIn: '7d' });

        // Session kaydet
        await db.query(
            `INSERT INTO wallet_sessions (address, jwt_token, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '7 days')
             ON CONFLICT (jwt_token) DO NOTHING`,
            [lowerAddress, token]
        );

        // Nonce'u sil
        await db.query(`DELETE FROM wallet_nonces WHERE address = $1`, [lowerAddress]);

        return c.json({ success: true, token, address: lowerAddress });

    } catch (error) {
        console.error('[AUTH-ERROR]', error);
        return c.json({ success: false, error: 'Doğrulama hatası.' }, 500);
    }
});

export default auth;

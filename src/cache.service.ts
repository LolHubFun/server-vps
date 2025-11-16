// src/cache.service.ts - REDIS İÇİN NİHAİ VE TAM VERSİYON

import Redis from 'ioredis';
import { appConfig } from './config.js';

// Redis bağlantısını bir kere oluşturup tüm uygulama boyunca yeniden kullanıyoruz.
// 'new Redis()' CommonJS modüllerinde çalışır, ESM için 'new Redis.default()' veya 'new (Redis as any)()' gerekebilir.
// En güvenli yöntem budur:
const redis = new (Redis as any)(appConfig.REDIS_URL, {
  // Olası bağlantı hatalarında yeniden bağlanmayı dene
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  // Komutlar için zaman aşımı
  commandTimeout: 5000, 
});

// Bağlantı durumlarını loglayalım
redis.on('connect', () => console.log('[REDIS] Successfully connected to Redis server.'));
redis.on('error', (err: any) => console.error('[REDIS-ERROR] Could not connect to Redis:', err.message));

export class CacheService {
  
  constructor() {
    // Constructor artık boş. Global 'redis' nesnesini kullanıyoruz.
  }

  /**
   * Veriyi Redis'ten okur.
   * @param key Okunacak anahtar.
   * @returns Veri varsa T tipinde, yoksa null döner.
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await redis.get(key);
      return data ? JSON.parse(data) as T : null;
    } catch (error) {
      console.error(`[REDIS-GET-ERROR] Failed to get key "${key}":`, error);
      return null;
    }
  }

  /**
   * Veriyi Redis'e yazar.
   * @param key Yazılacak anahtar.
   * @param data Yazılacak veri.
   * @param ttlSeconds Saniye cinsinden yaşam süresi (varsayılan 5 dakika).
   */
  async set<T>(key: string, data: T, ttlSeconds: number = 300): Promise<void> {
    try {
      // 'EX' parametresi, anahtarın ne kadar süre sonra otomatik silineceğini belirtir.
      await redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);
    } catch (error) {
      console.error(`[REDIS-SET-ERROR] Failed to set key "${key}":`, error);
    }
  }

  /**
   * Veriyi Redis'ten siler.
   * @param key Silinecek anahtar.
   */
  async delete(key: string): Promise<void> {
    try {
      await redis.del(key);
    } catch (error) {
      console.error(`[REDIS-DELETE-ERROR] Failed to delete key "${key}":`, error);
    }
  }
  
  /**
   * Bir projeye ait tüm ilişkili önbellek kayıtlarını temizler.
   * @param contractAddress Projenin kontrat adresi.
   */
  async clearProjectCache(contractAddress: string): Promise<void> {
    const lowerAddress = contractAddress.toLowerCase();
    const keysToDelete = [
      `project:detail:v4:${lowerAddress}`,
      `comments:v3:${lowerAddress}`,
      // Gelecekte bir projeyle ilgili eklenebilecek diğer cache anahtarları buraya eklenebilir.
    ];

    try {
      if (keysToDelete.length > 0) {
        await redis.del(keysToDelete);
      }
      console.log(`[CACHE] Cleared Redis cache for project: ${lowerAddress}`);
    } catch (error) {
      console.error(`[REDIS-MULTIDEL-ERROR] Failed to clear cache for ${lowerAddress}`, error);
    }
  }
}

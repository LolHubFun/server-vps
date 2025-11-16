// src/cache.service.ts - YENİ VPS MİMARİSİ İÇİN NİHAİ VERSİYON

import Redis from 'ioredis';
import 'dotenv/config'; // .env dosyasındaki değişkenleri yüklemek için

// Redis bağlantı URL'sini doğrudan process.env'den alıyoruz.
// appConfig gibi ek bir dosyaya gerek kalmadı.
const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  console.error('[REDIS-ERROR] CRITICAL: REDIS_URL is not defined in the .env file. Caching will be disabled.');
}

// Redis bağlantısını bir kere oluşturup tüm uygulama boyunca yeniden kullanıyoruz.
// redisUrl tanımsızsa, sahte bir client oluşturup hataları engelliyoruz.
const redis = redisUrl ? new (Redis as any)(redisUrl, {
  // Olası bağlantı hatalarında yeniden bağlanmayı dene
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 100, 3000); // 3 saniyeye kadar bekle
    return delay;
  },
  // Komutlar için zaman aşımı
  commandTimeout: 5000, 
  // Bağlantı kurulamazsa hemen hata verme
  enableOfflineQueue: true,
}) : null;

// Sadece redis client'ı varsa loglama yap
if (redis) {
    redis.on('connect', () => console.log('[REDIS] Successfully connected to Redis server.'));
    redis.on('error', (err: any) => console.error('[REDIS-ERROR] Could not connect to Redis:', err.message));
}

export class CacheService {
  
  constructor() {
    // Constructor artık tamamen boş.
  }

  /**
   * Veriyi Redis'ten okur.
   * @param key Okunacak anahtar.
   * @returns Veri varsa T tipinde, yoksa null döner.
   */
  async get<T>(key: string): Promise<T | null> {
    if (!redis) return null; // Redis yoksa null dön
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
    if (!redis) return; // Redis yoksa hiçbir şey yapma
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
    if (!redis) return; // Redis yoksa hiçbir şey yapma
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
    if (!redis) return; // Redis yoksa hiçbir şey yapma
    
    const lowerAddress = contractAddress.toLowerCase();
    const keysToDelete = [
      `project:detail:v4:${lowerAddress}`,
      `comments:v3:${lowerAddress}`,
      `replies:v1:${lowerAddress}`, // Olası reply cache'lerini de temizleyelim
    ];

    try {
      if (keysToDelete.length > 0) {
        // pipeline kullanarak birden fazla silme işlemini tek seferde gönder
        const pipeline = redis.pipeline();
        keysToDelete.forEach(key => pipeline.del(key));
        await pipeline.exec();
      }
      console.log(`[CACHE] Cleared Redis cache for project: ${lowerAddress}`);
    } catch (error) {
      console.error(`[REDIS-MULTIDEL-ERROR] Failed to clear cache for ${lowerAddress}`, error);
    }
  }
}

// worker/src/services/verification.service.ts - Etherscan API V2 İÇİN GÜNCELLENMİŞ NİHAİ VERSİYON

import { Env } from '../types.js';

// Bu yardımcı fonksiyon aynı kalıyor, çünkü API adresleri değişmedi.
function getApiUrlForChain(chainId: number): string {
    switch (chainId) {
        case 1:       return 'https://api.etherscan.io/api';
        case 80002:   return 'https://api-amoy.polygonscan.com/api';
        case 137:     return 'https://api.polygonscan.com/api';
        case 56:      return 'https://api.bscscan.com/api';
        case 43114:   return 'https://api.snowtrace.io/api';
        case 8453:    return 'https://api.basescan.org/api';
        case 42161:   return 'https://api.arbiscan.io/api';
        case 10:      return 'https://api-optimistic.etherscan.io/api';
        default:
            // Desteklenmeyen bir chainId gelirse hata fırlatmak en doğrusu.
            throw new Error(`Unsupported chainId for verification: ${chainId}`);
    }
}

// === ANA FONKSİYONUN GÜNCELLENMİŞ HALİ ===
export async function verifyProxyContract(env: Env, proxyAddress: string, chainId: number) {
    console.log(`[VERIFY-V2] Starting verification for proxy: ${proxyAddress} on chainId: ${chainId}`);
    
    // API anahtarını ortam değişkenlerinden al
    const apiKey = env.ETHERSCAN_API_KEY;
    if (!apiKey) {
        console.error("[VERIFY-V2] ETHERSCAN_API_KEY is not set. Skipping verification.");
        return; // Anahtar yoksa işlemi durdur
    }
    
    try {
        // Doğru API URL'ini al
        const apiUrl = getApiUrlForChain(chainId);

        // API'ye gönderilecek veriyi oluştur. V1 ile aynı parametreleri kullanıyor.
        const formData = new URLSearchParams({
            apikey: apiKey,
            module: 'contract',
            action: 'verifyproxycontract',
            address: proxyAddress,
        });

        // API isteğini gönder
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData.toString(),
        });

        // API'den gelen yanıtı JSON olarak işle
        const result = await response.json();

        // Yanıtı kontrol et
        // Başarılı durumlar: '1' (yeni gönderildi) veya 'OK' (zaten doğrulanmış)
        if (result.status === '1' || result.message === 'OK') {
            if (result.result?.includes('Already Verified')) {
                console.log(`[VERIFY-V2] Contract ${proxyAddress} is already verified.`);
            } else {
                // V2'de genellikle bekleme gerekmez, istek başarılıysa PolygonScan arka planda işler.
                console.log(`[VERIFY-V2] ✅ SUCCESS: Verification request for ${proxyAddress} was accepted. PolygonScan will process it shortly.`);
            }
        } else {
            // Hata durumunda, API'nin döndürdüğü hata mesajını fırlat
            throw new Error(`API Error: ${result.result || result.message}`);
        }
    } catch (error) {
        // Yakalanan tüm hataları logla
        console.error(`[VERIFY-V2] ❌ FAILED to verify contract ${proxyAddress} on chainId ${chainId}:`, error);
    }
}

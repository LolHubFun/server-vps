// worker/src/services/verification.service.ts - Etherscan API V2 İÇİN GÜNCELLENMİŞ NİHAİ VERSİYON

import { Env } from '../types.js';

const ETHERSCAN_V2_BASE = 'https://api.etherscan.io/v2/api';

function isSupportedChain(chainId: number): boolean {
    return [
        1,        // Ethereum
        5,        // Goerli (legacy but still mapped)
        10,       // Optimism
        56,       // BSC
        97,       // BSC Testnet
        137,      // Polygon
        80002,    // Polygon Amoy
        43114,    // Avalanche
        8453,     // Base
        42161     // Arbitrum
    ].includes(chainId);
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
    if (!isSupportedChain(chainId)) {
        console.warn(`[VERIFY-V2] Chain ${chainId} is not supported by the unified API. Skipping verification.`);
        return;
    }
    
    try {
        // API'ye gönderilecek veriyi oluştur. V2'de zinciri chainid parametresi ile belirtiyoruz.
        const formData = new URLSearchParams({
            apikey: apiKey,
            chainid: chainId.toString(),
            module: 'contract',
            action: 'verifyproxycontractv2',
            address: proxyAddress,
        });

        // API isteğini gönder
        const response = await fetch(ETHERSCAN_V2_BASE, {
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

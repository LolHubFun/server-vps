// worker/src/services/verification.service.ts - Etherscan API V2 İÇİN GÜNCELLENMİŞ NİHAİ VERSİYON

import { Env } from '../types.js';

const ETHERSCAN_V2_BASE = 'https://api.etherscan.io/v2/api';

const V2_SUPPORTED_CHAIN_IDS = new Set([
    1,      // Ethereum
    5,      // Goerli
    10,     // Optimism
    56,     // BSC Mainnet
    97,     // BSC Testnet
    137,    // Polygon Mainnet
    43114,  // Avalanche C-Chain
    8453,   // Base
    42161,  // Arbitrum One
    80002   // Polygon Amoy (Artık V2 kullanıyor)
]);

function getLegacyApiUrlForChain(chainId: number): string | null {
    switch (chainId) {
        case 137:     return 'https://api.polygonscan.com/api';
        case 80002:   return 'https://api-amoy.polygonscan.com/api';
        case 56:      return 'https://api.bscscan.com/api';
        case 97:      return 'https://api-testnet.bscscan.com/api';
        case 43114:   return 'https://api.snowtrace.io/api';
        case 8453:    return 'https://api.basescan.org/api';
        case 42161:   return 'https://api.arbiscan.io/api';
        case 10:      return 'https://api-optimistic.etherscan.io/api';
        case 5:       return 'https://api-goerli.etherscan.io/api';
        case 1:       return 'https://api.etherscan.io/api';
        default:      return null;
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
        const useV2 = V2_SUPPORTED_CHAIN_IDS.has(chainId);
        let targetUrl = ETHERSCAN_V2_BASE;
        const formData = new URLSearchParams({
            apikey: apiKey,
            module: 'contract',
            address: proxyAddress,
        });

        if (useV2) {
            formData.append('chainid', chainId.toString());
            formData.append('action', 'verifyproxycontractv2');
        } else {
            const legacyUrl = getLegacyApiUrlForChain(chainId);
            if (!legacyUrl) {
                console.warn(`[VERIFY-V2] No verification endpoint defined for chain ${chainId}. Skipping.`);
                return;
            }
            targetUrl = legacyUrl;
            formData.append('action', 'verifyproxycontract');
        }

        const response = await fetch(targetUrl, {
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

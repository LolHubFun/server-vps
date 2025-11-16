// worker/src/services/verification.service.ts - ÇOKLU ZİNCİR UYUMLU NİHAİ VERSİYON

import { Env } from '../types.js';

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
            throw new Error(`Unsupported chainId for verification: ${chainId}`);
    }
}

export async function verifyProxyContract(env: Env, proxyAddress: string, chainId: number) {
    console.log(`[VERIFY-SERVICE] Starting verification for proxy: ${proxyAddress} on chainId: ${chainId}`);
    const apiKey = env.ETHERSCAN_API_KEY;
    if (!apiKey) {
        console.error("[VERIFY-SERVICE] ETHERSCAN_API_KEY is not set. Skipping verification.");
        return;
    }
    try {
        const apiUrl = getApiUrlForChain(chainId);
        const formData = new URLSearchParams({
            apikey: apiKey,
            module: 'contract',
            action: 'verifyproxycontract',
            address: proxyAddress,
        });
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData.toString(),
        });
        const result = await response.json();
        if (result.status !== '1') {
            if (result.result?.includes('Already Verified')) {
                console.log(`[VERIFY-SERVICE] Contract ${proxyAddress} is already verified.`);
                return;
            }
            throw new Error(`API Error: ${result.result}`);
        }
        const guid = result.result;
        console.log(`[VERIFY-SERVICE] Verification submitted for ${proxyAddress}. GUID: ${guid}. Checking status in 15s...`);
        await new Promise(resolve => setTimeout(resolve, 15000));
        const statusResponse = await fetch(`${apiUrl}?module=contract&action=checkverifystatus&guid=${guid}&apikey=${apiKey}`);
        const statusResult = await statusResponse.json();
        if (statusResult.status === '1') {
            console.log(`[VERIFY-SERVICE] ✅ SUCCESS: Contract ${proxyAddress} verified on chainId ${chainId}!`);
        } else {
            throw new Error(`Verification failed after submission: ${statusResult.result}`);
        }
    } catch (error) {
        console.error(`[VERIFY-SERVICE] ❌ FAILED to verify contract ${proxyAddress} on chainId ${chainId}:`, error);
    }
}

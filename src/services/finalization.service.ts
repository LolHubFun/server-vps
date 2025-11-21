// backend/src/services/finalization.service.ts
import type { Pool } from 'pg';
import { createWalletClient, createPublicClient, http, getContract } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygonAmoy } from 'viem/chains';
import type { Env } from '../types.js';
import { uploadToArweave } from './arweave.service.js';
import { lolhubFunTokenABI } from '../lib/abi/lolhubFunTokenABI.js';

export async function handleFinalizationLogic(
    contractAddress: string,
    lpPairAddress: string, // Event'ten gelen LP adresi
    db: Pool,
    env: Env
) {
    console.log(`[FINALIZATION] Starting process for ${contractAddress}`);

    try {
        // 1. Proje Bilgilerini Çek
        const res = await db.query(
            'SELECT * FROM projects WHERE contract_address = $1',
            [contractAddress.toLowerCase()]
        );
        if (res.rowCount === 0) return;
        const project = res.rows[0];

        // 2. Vesting Wallet Adresini Bul (Blockchain Analizi)
        // LP Pair'e giden transfer dışındaki büyük transfer VestingWallet'ındır.
        // Bu kısım biraz dedektiflik gerektirir, şimdilik basit tutalım:
        // İdealde transaction hash'ten logları analiz edip buluruz.
        // MVP için: Kullanıcı claim edeceği zaman frontend hesaplar veya manuel eklenir.
        // Ama DB'yi güncelleyelim:
        await db.query(
            'UPDATE projects SET is_finalized = true, lp_pair_address = $1, finalization_status = \'COMPLETED\' WHERE contract_address = $2',
            [lpPairAddress, contractAddress.toLowerCase()]
        );

        // 3. ARWEAVE YÜKLEMESİ (Sonsuzluk Adımı)
        let arweaveId = '';
        if (project.current_logo_url) {
            try {
                console.log(`[FINALIZATION] Uploading logo to Arweave...`);
                arweaveId = await uploadToArweave(project.current_logo_url, env);
            } catch (err) {
                console.error('[FINALIZATION-ARWEAVE-ERROR]', err);
                // Arweave hatası akışı bozmasın, boş string ile devam et (veya retry mekanizması kur)
                arweaveId = 'ARWEAVE_UPLOAD_FAILED'; 
            }
        }

        // 4. ON-CHAIN MÜHÜRLEME (Set Final Identity)
        if (arweaveId && arweaveId !== 'ARWEAVE_UPLOAD_FAILED') {
            console.log(`[FINALIZATION] Sealing identity on-chain...`);
            
            const account = privateKeyToAccount(env.WORKER_WALLET_PRIVATE_KEY as `0x${string}`);
            const client = createWalletClient({
                account,
                chain: polygonAmoy,
                transport: http(env.INFURA_AMOY_RPC_URL)
            });

            const contract = getContract({
                address: contractAddress as `0x${string}`,
                abi: lolhubFunTokenABI,
                client
            });

            // setFinalIdentity fonksiyonunu çağır
            // Not: OnlyPlatformOwner yetkisi gerekir (ki bu bizim worker cüzdanımız)
            const hash = await contract.write.setFinalIdentity([
                project.current_name || 'Unknown',
                project.current_symbol || 'TOKEN',
                arweaveId
            ]);

            console.log(`[FINALIZATION] Identity sealed. Tx: ${hash}`);
        }

    } catch (error) {
        console.error(`[FINALIZATION-FATAL] Error processing ${contractAddress}:`, error);
    }
}

// backend/src/services/arweave.service.ts
import Arweave from 'arweave';
import fs from 'fs/promises';
import path from 'path';
import type { Env } from '../types.js';

export async function uploadToArweave(localFilePath: string, env: Env): Promise<string> {
    // 1. Arweave Bağlantısını Kur
    const arweave = Arweave.init({
        host: 'arweave.net',
        port: 443,
        protocol: 'https'
    });

    // 2. Anahtarı Al (Güvenlik: .env içinden parse et)
    let key;
    try {
        key = JSON.parse(env.ARWEAVE_KEYFILE_JSON);
    } catch (e) {
        throw new Error('ARWEAVE_KEYFILE_JSON is invalid or missing.');
    }

    // 3. Dosyayı Oku (VPS Diskten)
    // URL (https://...) gelirse dosya yoluna çevir
    let absolutePath = localFilePath;
    if (localFilePath.startsWith('http')) {
        const filename = localFilePath.split('/').pop();
        if (!filename) throw new Error('Invalid file path');
        absolutePath = path.join(process.cwd(), 'uploads', 'logos', filename);
    }

    const data = await fs.readFile(absolutePath);

    // 4. Transaction Oluştur
    const transaction = await arweave.createTransaction({ data }, key);
    
    // Metadata Etiketleri (Mime-type önemli)
    transaction.addTag('Content-Type', 'image/png'); // Genelde PNG kullanıyoruz
    transaction.addTag('App-Name', 'LolhubFun');
    transaction.addTag('Type', 'Logo');

    // 5. İmzala ve Gönder
    await arweave.transactions.sign(transaction, key);
    
    // Chunk'lar halinde yükle (Performans ve Büyük dosya desteği için)
    let uploader = await arweave.transactions.getUploader(transaction);
    while (!uploader.isComplete) {
        await uploader.uploadChunk();
    }

    console.log(`[ARWEAVE] File uploaded successfully. ID: ${transaction.id}`);
    
    // Transaction ID'yi (CID) döndür
    return transaction.id;
}

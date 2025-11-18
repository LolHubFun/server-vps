// src/storage.service.ts - SUNUCU İÇİN GÜNCELLENMİŞ NİHAİ VERSİYON

import { writeFile, unlink, mkdir } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

// Sunucudaki ana proje dizinini bulmak için (ör: /home/lolhub-fun/lolhub-backend)
const projectRoot = process.cwd();
const UPLOADS_DIR = path.join(projectRoot, 'uploads', 'logos');

/**
 * Verilen bir görsel buffer'ını sunucudaki 'uploads/logos' klasörüne kaydeder.
 * @returns Herkesin erişebileceği (public) URL.
 */
type ImageBuffer = ArrayBuffer | Buffer;

interface UploadLogoOptions {
  identifier: string;
  extension?: 'png' | 'jpg' | 'gif';
}

export async function uploadLogoToServer(
  imageBuffer: ImageBuffer,
  options: UploadLogoOptions
): Promise<string> {
  try {
    const { identifier, extension = 'png' } = options;
    // 'uploads/logos' klasörünün var olduğundan emin ol
    await mkdir(UPLOADS_DIR, { recursive: true });

    // Yeni, benzersiz bir dosya adı oluştur
    const safeIdentifier = (identifier || 'logo')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'logo';
    const fileExtension = extension;
    const fileName = `${safeIdentifier}-${crypto.randomUUID()}.${fileExtension}`;
    const filePath = path.join(UPLOADS_DIR, fileName);

    // Dosyayı sunucuya yaz
    const buffer = Buffer.isBuffer(imageBuffer)
      ? imageBuffer
      : Buffer.from(imageBuffer as ArrayBuffer);
    await writeFile(filePath, buffer);

    // .env dosyasından PUBLIC_HOSTNAME'i alarak tam URL oluştur
    const publicHostname = process.env.PUBLIC_HOSTNAME;
    if (!publicHostname) {
      throw new Error("PUBLIC_HOSTNAME is not set in .env file!");
    }

    const newUrl = `${publicHostname}/uploads/logos/${fileName}`;
    console.log(`[Storage] Uploaded new logo to server: ${newUrl}`);
    return newUrl;
  } catch (error) {
    console.error('[Storage-Upload-Error]', error);
    throw new Error('Logo could not be saved to the server.');
  }
}

/**
 * Sunucudaki bir logo dosyasını URL'inden yola çıkarak siler.
 */
export async function deleteLogoFromServer(logoUrl: string | null | undefined): Promise<void> {
  if (!logoUrl) return;

  try {
    // Sadece kendi sunucumuzdaki dosyaları silelim
    const publicHostname = process.env.PUBLIC_HOSTNAME;
    if (publicHostname && logoUrl.startsWith(publicHostname)) {
      const fileName = logoUrl.split('/').pop();
      if (fileName) {
        const filePath = path.join(UPLOADS_DIR, fileName);
        await unlink(filePath); // Dosyayı sil
        console.log(`[Storage] Deleted old logo from server: ${fileName}`);
      }
    }
  } catch (e) {
    // Dosya zaten yoksa hata vermesi normaldir, bu yüzden sadece loglayıp geçiyoruz.
    console.warn(`[Storage] Could not delete logo ${logoUrl}, it might not exist:`, e);
  }
}

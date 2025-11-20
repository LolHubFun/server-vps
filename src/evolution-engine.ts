// worker/src/evolution-engine.ts - Evrim tetikleyicisi ve mod mantığı - NİHAİ VERSİYON (MULTI-CHAIN)

import type { Pool } from 'pg';
import Replicate from 'replicate';
import type { CacheService } from './cache.service.js';
import type { Env } from './types.js';
import { uploadLogoToServer } from './storage.service.js';
import { parseEther } from 'viem';

interface ProjectRow {
  contract_address: string;
  evolution_mode: 'standard' | 'democracy' | 'chaos';
  current_milestone_index: number;
  evolution_status: 'IDLE' | 'PROCESSING';
  total_raised: string;
  current_name?: string;
  chain_id: number; // Zincir bilgisini ekledik
}

interface SuggestionRow {
  name_suggestion: string;
  char_suggestion: string;
}

// --- ZİNCİRE ÖZEL MİLESTONE AYARLARI ---

// 1. Grup: Düşük Değerli Tokenlar (MATIC, vb.) - Hedef 45k civarı
const MILESTONES_POLYGON = [
  parseEther('100'),   // 1. Evrim
  parseEther('500'),   // 2. Evrim
  parseEther('1500'),  // 3. Evrim
  parseEther('5000'),  // 4. Evrim
  parseEther('12000'), // 5. Evrim
  parseEther('30000'), // 6. Evrim
];

// 2. Grup: Yüksek Değerli Tokenlar (ETH, Base, Arb, Op) - Hedef 10-15 ETH civarı
const MILESTONES_ETH = [
  parseEther('0.05'), // ~150$
  parseEther('0.2'),  // ~600$
  parseEther('0.5'),  // ~1500$
  parseEther('1.5'),  // ~4500$
  parseEther('4'),    // ~12000$
  parseEther('8'),    // ~24000$
];

// 3. Grup: Orta Değerli Tokenlar (BNB, AVAX) - Hedef 50-1000 birim civarı
const MILESTONES_MID = [
  parseEther('2'),    // ~60-100$
  parseEther('10'),   
  parseEther('25'),
  parseEther('80'),
  parseEther('200'),
  parseEther('400'),
];

function getMilestonesForChain(chainId: number): bigint[] {
  switch (chainId) {
    case 1:     // Ethereum
    case 8453:  // Base
    case 42161: // Arbitrum
    case 10:    // Optimism
      return MILESTONES_ETH;
    
    case 56:    // BSC (BNB)
    case 43114: // Avalanche (AVAX)
      return MILESTONES_MID;

    case 137:   // Polygon
    case 80002: // Amoy Testnet
    default:
      return MILESTONES_POLYGON;
  }
}

export async function checkAndTriggerEvolution(
  contractAddress: string,
  db: Pool,
  cache: CacheService,
  env: Env
): Promise<boolean> {
  const lower = contractAddress.toLowerCase();

  // chain_id sütununu da çekiyoruz
  const { rows } = await db.query<ProjectRow>(
    `SELECT contract_address, evolution_mode, current_milestone_index, evolution_status, total_raised, current_name, chain_id
       FROM projects
       WHERE contract_address = $1
         AND is_finalized = false
         AND evolution_status = 'IDLE'
       LIMIT 1`,
    [lower]
  );

  if (rows.length === 0) {
    return false;
  }

  const project = rows[0];
  
  // Standart mod evrimleşmez, sadece para toplar
  if (project.evolution_mode === 'standard') {
    return false;
  }

  const currentRaised = BigInt(project.total_raised || '0');
  
  // Zincire uygun hedefleri al
  const milestones = getMilestonesForChain(project.chain_id);
  const target = milestones[project.current_milestone_index];

  // Hedef yoksa (son aşama) veya hedefe ulaşılmadıysa işlem yapma
  if (!target || currentRaised < target) {
    return false;
  }

  // KİLİTLEME: Yarış durumunu önlemek için durumu PROCESSING yap
  const updateResult = await db.query(
    `UPDATE projects
       SET evolution_status = 'PROCESSING'
     WHERE contract_address = $1
       AND evolution_status = 'IDLE'
     RETURNING contract_address`,
    [lower]
  );

  if (updateResult.rowCount === 0) {
    return false;
  }

  try {
    // AI ve Logo süreçlerini başlat
    await runEvolutionPipeline(project, db, env);

    // Başarılı olursa bir sonraki aşamaya geç ve kilidi aç
    await db.query(
      `UPDATE projects
         SET evolution_status = 'IDLE',
             current_milestone_index = current_milestone_index + 1,
             last_interaction_timestamp = NOW()
       WHERE contract_address = $1`,
      [lower]
    );
    
    // Önbelleği temizle ki frontend yeni logoyu görsün
    await cache.clearProjectCache(lower);
    return true;
  } catch (error) {
    console.error('[EVOLUTION-ERROR]', error);
    // Hata olursa kilidi aç ama milestone'u ilerletme (tekrar denesin)
    await db.query(
      `UPDATE projects
         SET evolution_status = 'IDLE'
       WHERE contract_address = $1`,
      [lower]
    );
    return false;
  }
}

async function runEvolutionPipeline(project: ProjectRow, db: Pool, env: Env) {
  console.log(`[EVOLUTION] Running pipeline for ${project.contract_address} in mode ${project.evolution_mode}`);

  // 1. Önerileri Çek
  const { rows: suggestions } = await db.query<SuggestionRow>(
    `SELECT name_suggestion, char_suggestion 
     FROM suggestions 
     WHERE project_contract_address = $1 
     ORDER BY created_at DESC LIMIT 50`, // Son 50 öneriyi al
    [project.contract_address.toLowerCase()]
  );

  // 2. Mod'a Göre Prompt ve İsim Oluştur
  let prompt = "";
  let newName = project.current_name || "Unnamed Project";

  if (project.evolution_mode === 'democracy') {
    const result = generateDemocracyPrompt(suggestions, project.current_name);
    prompt = result.prompt;
    newName = result.name;
  } else { // Chaos
    const result = generateChaosPrompt(suggestions, project.current_name);
    prompt = result.prompt;
    newName = result.name;
  }

  console.log(`[EVOLUTION] Generated Prompt: "${prompt}"`);
  console.log(`[EVOLUTION] Selected Name: "${newName}"`);

  // 3. Replicate AI ile Görsel Üret (Flux-Schnell: Hızlı ve Kaliteli)
  if (!env.REPLICATE_API_TOKEN) {
    throw new Error("REPLICATE_API_TOKEN is not configured");
  }

  const replicate = new Replicate({
    auth: env.REPLICATE_API_TOKEN,
  });

  // Güvenli prompt (NSFW koruması eklenebilir, şimdilik basit tutuyoruz)
  const fullPrompt = `A high quality, vibrant, vector-style logo of ${prompt}. Minimalist background, professional crypto token logo style.`;

  const output = await replicate.run(
    "black-forest-labs/flux-schnell", // Hızlı model
    {
      input: {
        prompt: fullPrompt,
        num_outputs: 1,
        aspect_ratio: "1:1",
        output_format: "png",
        output_quality: 80,
      },
    }
  );

  // Output genellikle bir stream veya URL listesidir
  const imageUrl = Array.isArray(output) ? output[0] : (output as any).toString();
  
  if (!imageUrl) {
    throw new Error("Replicate did not return a valid image URL");
  }

  // 4. Görseli İndir ve Sunucuya Kaydet
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) throw new Error("Failed to download image from Replicate");
  
  const arrayBuffer = await imageRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // storage.service.ts içindeki fonksiyonu kullanıyoruz
  const uploadedLogoUrl = await uploadLogoToServer(buffer, {
    identifier: newName,
    extension: 'png'
  });

  console.log(`[EVOLUTION] Logo saved to: ${uploadedLogoUrl}`);

  // 5. Veritabanını Güncelle (İsim ve Logo)
  await db.query(
    `UPDATE projects 
     SET current_name = $1, 
         current_logo_url = $2,
         updated_at = NOW()
     WHERE contract_address = $3`,
    [newName, uploadedLogoUrl, project.contract_address.toLowerCase()]
  );
}

// --- YARDIMCI FONKSİYONLAR (Prompt Logic) ---

function generateDemocracyPrompt(suggestions: SuggestionRow[], currentName?: string): { prompt: string, name: string } {
  // Eğer hiç öneri yoksa varsayılan döndür
  if (suggestions.length === 0) {
    return { 
      prompt: "a mysterious creature evolving in the digital void", 
      name: currentName || "Democracy Project" 
    };
  }

  // 1. En çok tekrar eden kelimeleri bul (Logo için)
  const allText = suggestions.map(s => s.char_suggestion).join(" ").toLowerCase();
  const words = allText.replace(/[^\w\s]/g, '').split(/\s+/);
  const stopWords = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'with', 'and', 'is', 'to', 'it', 'for', 'my', 'frog', 'token', 'coin', 'logo']); // 'frog' veya 'token' gibi çok genel kelimeleri hariç tutabiliriz
  
  const frequency: Record<string, number> = {};
  words.forEach(w => {
    if (!stopWords.has(w) && w.length > 2) {
      frequency[w] = (frequency[w] || 0) + 1;
    }
  });

  const sortedWords = Object.entries(frequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3) // En popüler 3 kelime
    .map(entry => entry[0]);

  // 2. En popüler ismi seç (veya rastgele birini)
  // Democracy modunda genelde en çok tekrar eden isim seçilir ama basitlik için rastgele bir öneri ismini alıyoruz
  const randomNameIndex = Math.floor(Math.random() * suggestions.length);
  const selectedName = suggestions[randomNameIndex].name_suggestion || currentName || "Evolved Token";

  const prompt = sortedWords.length > 0 
    ? `${sortedWords.join(" ")} character` 
    : "a cool evolved creature";

  return { prompt, name: selectedName };
}

function generateChaosPrompt(suggestions: SuggestionRow[], currentName?: string): { prompt: string, name: string } {
  if (suggestions.length === 0) {
    return { 
      prompt: "abstract chaotic glitch art, colorful shapes", 
      name: currentName || "Chaos Project" 
    };
  }

  // Chaos: Rastgele 3 öneriyi birleştir
  const shuffled = suggestions.sort(() => 0.5 - Math.random()).slice(0, 3);
  const promptParts = shuffled.map(s => s.char_suggestion).filter(s => s.length > 0);
  
  // Chaos: İsim de rastgele değişebilir veya birleşebilir
  const nameSuggestion = shuffled[0].name_suggestion || currentName || "Chaos Token";

  const prompt = promptParts.length > 0 
    ? `A chaotic fusion of: ${promptParts.join(" AND ")}. Surreal, weird, glitchy style.`
    : "A weird abstract creature";

  return { prompt, name: nameSuggestion };
}

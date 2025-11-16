-- ⭐ SON ETKİLEŞİM ZAMAN DAMGASI EKLE
ALTER TABLE projects 
ADD COLUMN IF NOT EXISTS last_interaction_timestamp TIMESTAMPTZ DEFAULT NOW();

-- ⭐ İNDEKS OLUŞTUR - PERFORMANS İÇİN KRİTİK
CREATE INDEX IF NOT EXISTS idx_projects_last_interaction ON projects(last_interaction_timestamp);
CREATE INDEX IF NOT EXISTS idx_projects_active_status ON projects(is_finalized, last_interaction_timestamp);

-- ⭐ VAR OLAN PROJELER İÇİN GÜNCELLEME
UPDATE projects 
SET last_interaction_timestamp = updated_at 
WHERE last_interaction_timestamp IS NULL;
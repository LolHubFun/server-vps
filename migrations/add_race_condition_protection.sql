-- projects tablosuna gerekli sütunları ekle
ALTER TABLE projects 
ADD COLUMN IF NOT EXISTS last_processed_block BIGINT,
ADD COLUMN IF NOT EXISTS last_processed_tx_hash TEXT,
ADD COLUMN IF NOT EXISTS processed_blocks JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS emergency_lock_reason TEXT,
ADD COLUMN IF NOT EXISTS emergency_lock_timestamp TIMESTAMPTZ;

-- indeksler oluştur (performans için kritik)
CREATE INDEX IF NOT EXISTS idx_projects_last_processed_block ON projects(last_processed_block);
CREATE INDEX IF NOT EXISTS idx_projects_evolution_status ON projects(evolution_status);
CREATE INDEX IF NOT EXISTS idx_projects_emergency_lock ON projects(emergency_lock_timestamp) WHERE emergency_lock_timestamp IS NOT NULL;
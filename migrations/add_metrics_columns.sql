-- packages/worker/migrations/add_metrics_columns.sql

ALTER TABLE projects
ADD COLUMN IF NOT EXISTS total_raised NUMERIC(78, 0) DEFAULT 0, -- Toplam toplanan miktar (wei olarak)
ADD COLUMN IF NOT EXISTS market_cap NUMERIC(78, 0) DEFAULT 0,  -- Piyasa değeri (wei olarak)
ADD COLUMN IF NOT EXISTS holders_count INTEGER DEFAULT 0,        -- Sahip sayısı
ADD COLUMN IF NOT EXISTS volume_24h NUMERIC(78, 0) DEFAULT 0,    -- 24 saatlik hacim (wei olarak)
ADD COLUMN IF NOT EXISTS price_change_24h REAL DEFAULT 0.0;      -- 24 saatlik fiyat değişimi (%)

-- Performans için indeksler
CREATE INDEX IF NOT EXISTS idx_projects_market_cap ON projects(market_cap DESC);
CREATE INDEX IF NOT EXISTS idx_projects_volume_24h ON projects(volume_24h DESC);

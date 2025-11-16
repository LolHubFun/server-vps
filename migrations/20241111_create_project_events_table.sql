-- ⭐ PROJECT EVENTS TABLOSU - EVENT LOGGING VE DUPLICATE PREVENTION
-- Bu tablo, blockchain event'lerinin kaydını tutar ve duplicate event processing'i önler
-- Created: 2024-11-11

-- Ana tablo oluşturma
CREATE TABLE IF NOT EXISTS project_events (
    id SERIAL PRIMARY KEY,
    contract_address TEXT NOT NULL,
    block_number TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    event_name TEXT NOT NULL,
    event_data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Aynı event'in birden fazla kaydedilmesini önle
    UNIQUE(tx_hash, event_name, contract_address)
);

-- Performans indeksleri
CREATE INDEX IF NOT EXISTS idx_project_events_contract ON project_events(contract_address);
CREATE INDEX IF NOT EXISTS idx_project_events_block ON project_events(block_number);
CREATE INDEX IF NOT EXISTS idx_project_events_tx_hash ON project_events(tx_hash);
CREATE INDEX IF NOT EXISTS idx_project_events_created_at ON project_events(created_at DESC);

-- Event temizleme için composite index (30 günden eski event'leri silmek için)
CREATE INDEX IF NOT EXISTS idx_project_events_cleanup ON project_events(created_at) 
WHERE created_at < NOW() - INTERVAL '30 days';

-- Yorum ekle
COMMENT ON TABLE project_events IS 'Stores all blockchain events for duplicate prevention and audit trail';
COMMENT ON COLUMN project_events.event_data IS 'Full event data stored as JSONB for flexible querying';
COMMENT ON INDEX idx_project_events_cleanup IS 'Used for cleaning up events older than 30 days';

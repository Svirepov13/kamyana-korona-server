-- ═══════════════════════════════════════════
-- МІГРАЦІЯ v0.7 — запусти в Supabase SQL Editor
-- ═══════════════════════════════════════════

-- Додати колонку saved_at для точного відліку ресурсів
ALTER TABLE players 
ADD COLUMN IF NOT EXISTS saved_at TIMESTAMP DEFAULT NOW();

-- Встановити поточний час для всіх існуючих гравців  
UPDATE players SET saved_at = NOW() WHERE saved_at IS NULL;

-- Перевірка
SELECT id, username, food, wood, stone, saved_at FROM players;

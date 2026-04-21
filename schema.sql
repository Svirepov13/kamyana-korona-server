-- ═══════════════════════════════════════════
-- КАМ'ЯНА КОРОНА — Database Schema
-- Запусти це в Supabase SQL Editor
-- ═══════════════════════════════════════════

-- ГРАВЦІ
CREATE TABLE IF NOT EXISTS players (
  id          SERIAL PRIMARY KEY,
  username    VARCHAR(32) UNIQUE NOT NULL,
  email       VARCHAR(128) UNIQUE NOT NULL,
  password    VARCHAR(128) NOT NULL,  -- bcrypt hash
  created_at  TIMESTAMP DEFAULT NOW(),
  last_online TIMESTAMP DEFAULT NOW(),
  -- Позиція на карті (рандомна при реєстрації)
  map_q       INT DEFAULT 24,
  map_r       INT DEFAULT 17,
  -- Ресурси
  food        FLOAT DEFAULT 50,
  wood        FLOAT DEFAULT 50,
  stone       FLOAT DEFAULT 20,
  -- Епоха
  epoch       INT DEFAULT 0
);

-- БУДІВЛІ ГРАВЦЯ
CREATE TABLE IF NOT EXISTS buildings (
  id          SERIAL PRIMARY KEY,
  player_id   INT REFERENCES players(id) ON DELETE CASCADE,
  type        VARCHAR(32) NOT NULL,  -- townhall, farm, lumber...
  level       INT DEFAULT 0,
  busy        BOOLEAN DEFAULT FALSE,
  finish_at   BIGINT DEFAULT 0,      -- unix ms timestamp
  UNIQUE(player_id, type)
);

-- ТЕХНОЛОГІЇ ГРАВЦЯ
CREATE TABLE IF NOT EXISTS techs (
  id          SERIAL PRIMARY KEY,
  player_id   INT REFERENCES players(id) ON DELETE CASCADE,
  type        VARCHAR(32) NOT NULL,
  done        BOOLEAN DEFAULT FALSE,
  busy        BOOLEAN DEFAULT FALSE,
  finish_at   BIGINT DEFAULT 0,
  UNIQUE(player_id, type)
);

-- АРМІЯ ГРАВЦЯ
CREATE TABLE IF NOT EXISTS army (
  id          SERIAL PRIMARY KEY,
  player_id   INT REFERENCES players(id) ON DELETE CASCADE,
  hunters     INT DEFAULT 0,
  spearmen    INT DEFAULT 0,
  scouts      INT DEFAULT 0,
  UNIQUE(player_id)
);

-- ЗАВОЙОВАНІ КЛІТИНКИ
CREATE TABLE IF NOT EXISTS owned_cells (
  id          SERIAL PRIMARY KEY,
  player_id   INT REFERENCES players(id) ON DELETE CASCADE,
  map_q       INT NOT NULL,
  map_r       INT NOT NULL,
  cell_type   VARCHAR(32),
  conquered_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(player_id, map_q, map_r)
);

-- АТАКИ між гравцями
CREATE TABLE IF NOT EXISTS attacks (
  id           SERIAL PRIMARY KEY,
  attacker_id  INT REFERENCES players(id),
  defender_id  INT REFERENCES players(id),
  result       VARCHAR(16),  -- 'win','loss','draw'
  attacker_loss JSON,
  defender_loss JSON,
  rewards      JSON,
  created_at   TIMESTAMP DEFAULT NOW()
);

-- ПОВІДОМЛЕННЯ ЧАТУ
CREATE TABLE IF NOT EXISTS messages (
  id          SERIAL PRIMARY KEY,
  player_id   INT REFERENCES players(id) ON DELETE CASCADE,
  username    VARCHAR(32) NOT NULL,
  text        VARCHAR(500) NOT NULL,
  type        VARCHAR(16) DEFAULT 'global',  -- 'global','system'
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ІНДЕКСИ для швидкості
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_owned_cells_player ON owned_cells(player_id);
CREATE INDEX IF NOT EXISTS idx_buildings_player ON buildings(player_id);

-- ═══════════════════════════════════════════
-- ФУНКЦІЯ: ініціалізувати гравця при реєстрації
-- ═══════════════════════════════════════════
CREATE OR REPLACE FUNCTION init_player(p_id INT)
RETURNS void AS $$
BEGIN
  -- Будівлі (townhall level 1, решта 0)
  INSERT INTO buildings (player_id, type, level) VALUES
    (p_id, 'townhall',   1),
    (p_id, 'farm',       0),
    (p_id, 'lumber',     0),
    (p_id, 'quarry',     0),
    (p_id, 'barracks',   0),
    (p_id, 'storehouse', 0)
  ON CONFLICT DO NOTHING;

  -- Технології
  INSERT INTO techs (player_id, type) VALUES
    (p_id, 'agriculture'),
    (p_id, 'logging'),
    (p_id, 'masonry'),
    (p_id, 'warfare'),
    (p_id, 'trading')
  ON CONFLICT DO NOTHING;

  -- Армія
  INSERT INTO army (player_id) VALUES (p_id)
  ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql;

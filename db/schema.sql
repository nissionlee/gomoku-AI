-- 五子棋多用户对战 · D1 表结构
-- 执行：npx wrangler d1 execute gomoku-ai-db --remote --file=db/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  display_name  TEXT,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS games (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code     TEXT    NOT NULL UNIQUE,
  black_user_id INTEGER,
  white_user_id INTEGER,
  status        TEXT    NOT NULL DEFAULT 'waiting', -- waiting | playing | finished
  turn          INTEGER NOT NULL DEFAULT 1,          -- 1=黑 2=白
  winner        INTEGER,                             -- 1 | 2 | 0(和棋) | NULL
  win_reason    TEXT,
  moves         TEXT    NOT NULL DEFAULT '[]',       -- JSON: [{r,c,color,at}]
  created_by    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (black_user_id) REFERENCES users(id),
  FOREIGN KEY (white_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_token   ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_games_room       ON games(room_code);
CREATE INDEX IF NOT EXISTS idx_games_black      ON games(black_user_id);
CREATE INDEX IF NOT EXISTS idx_games_white      ON games(white_user_id);
CREATE INDEX IF NOT EXISTS idx_games_updated    ON games(updated_at);

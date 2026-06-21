const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync("data.sqlite");

database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    user_name TEXT
  ) STRICT
`);

database.exec(`
  CREATE TABLE IF NOT EXISTS chat_history (
    message_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    intent TEXT,
    message_content TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users (user_id)
  ) STRICT
`);

database.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  ) STRICT
`);

database.exec(`
  CREATE TABLE IF NOT EXISTS tool_customization_requests (
    request_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    channel_id TEXT,
    request_text TEXT NOT NULL,
    review_json TEXT,
    status TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users (user_id)
  ) STRICT
`);

database.exec(`
  CREATE TABLE IF NOT EXISTS custom_api_tools (
    tool_name TEXT PRIMARY KEY,
    spec_json TEXT NOT NULL,
    source_request_id INTEGER,
    created_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (created_by) REFERENCES users (user_id),
    FOREIGN KEY (source_request_id) REFERENCES tool_customization_requests (request_id)
  ) STRICT
`);

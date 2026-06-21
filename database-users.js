const { DatabaseSync } = require("node:sqlite");

const dbPath = "data.sqlite";
const database = new DatabaseSync(dbPath);
const DEFAULT_HISTORY_LIMIT = 15;

function normalizeHistoryLimit(limit) {
  const parsedLimit = Number.parseInt(limit, 10);

  if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
    return DEFAULT_HISTORY_LIMIT;
  }

  return Math.min(parsedLimit, DEFAULT_HISTORY_LIMIT);
}

function findUser(userId) {
  const query = database.prepare(`
    SELECT * FROM users
    WHERE user_id = ?
  `);

  return query.get(userId);
}

function initUser(userId, userName) {
  if (findUser(userId)) return;
  const insert = database.prepare(`
    INSERT INTO users (user_id, user_name) VALUES (?, ?)
  `);

  insert.run(userId, userName);
}

function getHistory(userId, intent, limit = DEFAULT_HISTORY_LIMIT) {
  const historyLimit = normalizeHistoryLimit(limit);
  const query = database.prepare(`
    SELECT * FROM chat_history
    WHERE user_id = ? AND intent = ?
    ORDER BY created_at DESC, message_id DESC
    LIMIT ?
  `);

  return query.all(userId, intent, historyLimit).reverse();
}

function updateHistory(userId, { intent, summary, messageContent }) {
  const content = messageContent ?? summary ?? "";
  const insert = database.prepare(`
    INSERT INTO chat_history (user_id, intent, message_content) VALUES (?, ?, ?)
  `);

  insert.run(userId, intent, content);
}

module.exports = {
  findUser,
  initUser,
  getHistory,
  updateHistory,
  DEFAULT_HISTORY_LIMIT,
};

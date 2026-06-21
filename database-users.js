const { DatabaseSync } = require("node:sqlite");

require("./database-init.js");

const dbPath = "data.sqlite";
const database = new DatabaseSync(dbPath);
const DEFAULT_HISTORY_LIMIT = 15;
const MAX_HISTORY_ADMIN_LIMIT = 50;

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

function normalizeAdminHistoryLimit(limit) {
  const parsedLimit = Number.parseInt(limit, 10);

  if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
    return DEFAULT_HISTORY_LIMIT;
  }

  return Math.min(parsedLimit, MAX_HISTORY_ADMIN_LIMIT);
}

function listChatHistory(userId, { intent, limit } = {}) {
  const historyLimit = normalizeAdminHistoryLimit(limit);

  if (intent) {
    const query = database.prepare(`
      SELECT * FROM chat_history
      WHERE user_id = ? AND intent = ?
      ORDER BY created_at DESC, message_id DESC
      LIMIT ?
    `);

    return query.all(userId, intent, historyLimit);
  }

  const query = database.prepare(`
    SELECT * FROM chat_history
    WHERE user_id = ?
    ORDER BY created_at DESC, message_id DESC
    LIMIT ?
  `);

  return query.all(userId, historyLimit);
}

function getChatHistoryRecord(userId, messageId) {
  const query = database.prepare(`
    SELECT * FROM chat_history
    WHERE user_id = ? AND message_id = ?
  `);

  return query.get(userId, messageId);
}

function updateChatHistoryRecord(userId, messageId, updates) {
  const existingRecord = getChatHistoryRecord(userId, messageId);
  if (!existingRecord) return false;

  const nextIntent = updates.intent ?? existingRecord.intent;
  const nextContent =
    updates.messageContent ?? existingRecord.message_content ?? "";

  const query = database.prepare(`
    UPDATE chat_history
    SET intent = ?, message_content = ?
    WHERE user_id = ? AND message_id = ?
  `);

  query.run(nextIntent, nextContent, userId, messageId);
  return true;
}

function deleteChatHistoryRecord(userId, messageId) {
  const query = database.prepare(`
    DELETE FROM chat_history
    WHERE user_id = ? AND message_id = ?
  `);

  const result = query.run(userId, messageId);
  return result.changes;
}

function clearChatHistory(userId, intent) {
  if (intent) {
    const query = database.prepare(`
      DELETE FROM chat_history
      WHERE user_id = ? AND intent = ?
    `);

    const result = query.run(userId, intent);
    return result.changes;
  }

  const query = database.prepare(`
    DELETE FROM chat_history
    WHERE user_id = ?
  `);

  const result = query.run(userId);
  return result.changes;
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
  listChatHistory,
  getChatHistoryRecord,
  updateChatHistoryRecord,
  deleteChatHistoryRecord,
  clearChatHistory,
  updateHistory,
  DEFAULT_HISTORY_LIMIT,
};

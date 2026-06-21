const { DatabaseSync } = require("node:sqlite");

require("./database-init.js");

const database = new DatabaseSync("data.sqlite");

function getSetting(key) {
  const query = database.prepare(`
    SELECT setting_value FROM app_settings
    WHERE setting_key = ?
  `);

  const row = query.get(key);
  return row ? row.setting_value : null;
}

function setSetting(key, value) {
  const query = database.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = CURRENT_TIMESTAMP
  `);

  query.run(key, value);
}

function deleteSetting(key) {
  const query = database.prepare(`
    DELETE FROM app_settings
    WHERE setting_key = ?
  `);

  query.run(key);
}

function createToolCustomizationRequest({
  userId,
  channelId,
  requestText,
  review,
  status,
}) {
  const query = database.prepare(`
    INSERT INTO tool_customization_requests (
      user_id,
      channel_id,
      request_text,
      review_json,
      status
    )
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = query.run(
    userId,
    channelId,
    requestText,
    review ? JSON.stringify(review) : null,
    status,
  );

  return result.lastInsertRowid;
}

function upsertCustomApiTool({ toolName, spec, sourceRequestId, createdBy }) {
  const query = database.prepare(`
    INSERT INTO custom_api_tools (
      tool_name,
      spec_json,
      source_request_id,
      created_by,
      updated_at
    )
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(tool_name) DO UPDATE SET
      spec_json = excluded.spec_json,
      source_request_id = excluded.source_request_id,
      updated_at = CURRENT_TIMESTAMP
  `);

  query.run(toolName, JSON.stringify(spec), sourceRequestId, createdBy);
}

function listCustomApiTools() {
  const query = database.prepare(`
    SELECT * FROM custom_api_tools
    ORDER BY tool_name ASC
  `);

  return query.all().map((row) => ({
    ...row,
    spec: JSON.parse(row.spec_json),
  }));
}

function getCustomApiTool(toolName) {
  const query = database.prepare(`
    SELECT * FROM custom_api_tools
    WHERE tool_name = ?
  `);

  const row = query.get(toolName);
  if (!row) return null;

  return {
    ...row,
    spec: JSON.parse(row.spec_json),
  };
}

module.exports = {
  getSetting,
  setSetting,
  deleteSetting,
  createToolCustomizationRequest,
  upsertCustomApiTool,
  listCustomApiTools,
  getCustomApiTool,
};

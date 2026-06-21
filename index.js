require("dotenv").config();

require("./database-init.js");

const { App } = require("@slack/bolt");

const {
  analyzeMessage,
  processRequest,
  executeAction,
  reviewToolCustomizationRequest,
  formatWithPersonality,
} = require("./ai-api.js");
const {
  defaultPersonalitySystemPrompt,
  toolsList,
} = require("./prompts.js");

const {
  getHistory,
  updateHistory,
  initUser,
  listChatHistory,
  getChatHistoryRecord,
  updateChatHistoryRecord,
  deleteChatHistoryRecord,
  clearChatHistory,
} = require("./database-users.js");
const {
  getSetting,
  setSetting,
  deleteSetting,
  createToolCustomizationRequest,
} = require("./database-settings.js");

const CONTEXT_MESSAGE_LIMIT = 15;
const PERSONALITY_PROMPT_SETTING_KEY = "personality_system_prompt";
const DISABLED_TOOLS_SETTING_KEY = "disabled_tools";
const MAX_PERSONALITY_PROMPT_CHARS = 4000;
const MAX_TOOL_REQUEST_CHARS = 4000;
const DEFAULT_HISTORY_COMMAND_LIMIT = 10;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

function logProgress(step, message) {
  console.log(`[PROGRESS][${step}] ${message}`);
}

function slackCodeBlock(value) {
  return `\`\`\`\n${String(value).replace(/```/g, "'''")}\n\`\`\``;
}

function parseJsonSetting(key, fallback) {
  const rawValue = getSetting(key);
  if (!rawValue) return fallback;

  try {
    return JSON.parse(rawValue);
  } catch (error) {
    console.warn(`[WARN] Failed to parse setting ${key}: ${error.message}`);
    return fallback;
  }
}

function getDisabledToolNames() {
  const value = parseJsonSetting(DISABLED_TOOLS_SETTING_KEY, []);
  if (!Array.isArray(value)) return new Set();

  return new Set(
    value
      .map((name) => String(name || "").trim())
      .filter(Boolean),
  );
}

function saveDisabledToolNames(disabledToolNames) {
  setSetting(
    DISABLED_TOOLS_SETTING_KEY,
    JSON.stringify([...disabledToolNames].sort()),
  );
}

function getActiveTools() {
  const disabledToolNames = getDisabledToolNames();
  return toolsList.filter((tool) => !disabledToolNames.has(tool.name));
}

function getToolByName(toolName) {
  return toolsList.find((tool) => tool.name === toolName);
}

function formatToolsForSlack(toolList = toolsList) {
  const disabledToolNames = getDisabledToolNames();

  return toolList
    .map((tool) => {
      const parameters = Object.keys(tool.parameters || {}).join(", ");
      const status = disabledToolNames.has(tool.name) ? "disabled" : "active";
      return `- ${tool.name} (${status}): ${tool.description} Parameters: ${parameters || "none"}.`;
    })
    .join("\n");
}

function formatReviewList(items) {
  if (!Array.isArray(items) || items.length === 0) return "- None.";

  return items.map((item) => `- ${item}`).join("\n");
}

function normalizeToolReview(review) {
  return {
    summary: review && review.summary ? review.summary : "No summary returned.",
    recommendation:
      review && review.recommendation
        ? review.recommendation
        : "needs_clarification",
    security_notes:
      review && Array.isArray(review.security_notes)
        ? review.security_notes
        : [],
    implementation_notes:
      review && Array.isArray(review.implementation_notes)
        ? review.implementation_notes
        : [],
  };
}

function parseHistoryListArgs(args) {
  if (args[0] === "intent") {
    return {
      intent: args[1],
      limit: args[2] || DEFAULT_HISTORY_COMMAND_LIMIT,
    };
  }

  return {
    intent: null,
    limit: args[0] || DEFAULT_HISTORY_COMMAND_LIMIT,
  };
}

function formatHistoryRecord(record) {
  const content = String(record.message_content || "").replace(/\s+/g, " ");
  const clippedContent =
    content.length > 160 ? `${content.slice(0, 157)}...` : content;

  return `#${record.message_id} [${record.intent}] ${record.created_at}: ${clippedContent}`;
}

function formatHistoryRecords(records) {
  if (!records.length) return "No chat history rows found.";

  return records.map(formatHistoryRecord).join("\n");
}

function normalizeSlackMessage(message) {
  const text = message.text ? message.text.replace(/\s+/g, " ").trim() : "";

  if (!text) return null;

  return {
    sender: message.user || message.username || message.bot_id || "unknown",
    text,
    ts: message.ts,
  };
}

async function getPreviousChannelMessages(client, channelId) {
  if (!client || !channelId) return [];

  try {
    logProgress(
      "context",
      `Fetching up to ${CONTEXT_MESSAGE_LIMIT} previous Slack messages from channel ${channelId}.`,
    );

    const response = await client.conversations.history({
      channel: channelId,
      limit: CONTEXT_MESSAGE_LIMIT,
    });

    if (!response.ok) {
      console.warn(
        `[WARN] Slack history fetch failed: ${response.error || "unknown error"}`,
      );
      return [];
    }

    return (response.messages || [])
      .map(normalizeSlackMessage)
      .filter(Boolean)
      .reverse();
  } catch (error) {
    console.warn(`[WARN] Slack history fetch failed: ${error.message}`);
    return [];
  }
}

app.command("/ach-ping", async ({ command, ack, respond }) => {
  const start = Date.now();
  await ack();
  const latency = Date.now() - start;
  await respond({ text: `Pong!\nLatency: ${latency}ms` });
});

app.command("/ach-personality", async ({ command, ack, respond }) => {
  await ack();
  logProgress("personality", "Personality command acknowledged.");

  const { user_id: userId, user_name: username } = command;
  const text = (command.text || "").trim();
  const lowerText = text.toLowerCase();

  initUser(userId, username);

  const currentPrompt = getSetting(PERSONALITY_PROMPT_SETTING_KEY);
  const currentStatus = currentPrompt ? "custom" : "default";

  if (!text || lowerText === "help" || lowerText === "show") {
    const currentPromptText = currentPrompt
      ? `\nCurrent custom system prompt:\n${slackCodeBlock(currentPrompt)}`
      : "";

    await respond({
      text:
        `Personality is currently using the ${currentStatus} system prompt.\n\n` +
        "Usage:\n" +
        "- `/ach-personality show`\n" +
        "- `/ach-personality reset`\n" +
        "- `/ach-personality <new system prompt>`\n\n" +
        "Original system prompt for reference:\n" +
        slackCodeBlock(defaultPersonalitySystemPrompt) +
        currentPromptText,
    });
    return;
  }

  if (lowerText === "reset") {
    deleteSetting(PERSONALITY_PROMPT_SETTING_KEY);
    logProgress("personality", "Personality prompt reset to original.");

    await respond({
      text:
        "Personality reset to the original system prompt.\n\n" +
        "Original system prompt for reference:\n" +
        slackCodeBlock(defaultPersonalitySystemPrompt),
    });
    return;
  }

  const newPrompt = lowerText.startsWith("set ")
    ? text.slice(4).trim()
    : text;

  if (!newPrompt) {
    await respond({
      text: "Please provide a new system prompt after `/ach-personality`.",
    });
    return;
  }

  if (newPrompt.length > MAX_PERSONALITY_PROMPT_CHARS) {
    await respond({
      text: `That personality prompt is ${newPrompt.length} characters. Please keep it under ${MAX_PERSONALITY_PROMPT_CHARS} characters.`,
    });
    return;
  }

  setSetting(PERSONALITY_PROMPT_SETTING_KEY, newPrompt);
  logProgress("personality", "Custom personality prompt saved.");

  await respond({
    text:
      "Custom personality prompt saved. It affects final response styling only; tool selection and action execution still use the separate assistant prompt.\n\n" +
      "Original system prompt for reference:\n" +
      slackCodeBlock(defaultPersonalitySystemPrompt) +
      "\nNew custom system prompt:\n" +
      slackCodeBlock(newPrompt),
  });
});

app.command("/ach-customize-tool", async ({ command, ack, respond }) => {
  await ack();
  logProgress("tools", "Tool customization command acknowledged.");

  const { user_id: userId, user_name: username, channel_id: channelId } =
    command;
  const text = (command.text || "").trim();
  const lowerText = text.toLowerCase();

  initUser(userId, username);

  if (!text || lowerText === "help" || lowerText === "list") {
    await respond({
      text:
        "Runtime tool customization is intentionally disabled for security. This command records a source-code tool request and runs a security review before anyone implements it.\n\n" +
        "Usage:\n" +
        "- `/ach-customize-tool list`\n" +
        "- `/ach-customize-tool request <describe the tool you want>`\n\n" +
        "Current available tools:\n" +
        formatToolsForSlack(),
    });
    return;
  }

  const requestText = lowerText.startsWith("request ")
    ? text.slice(8).trim()
    : text;

  if (!requestText) {
    await respond({
      text: "Please describe the tool you want after `/ach-customize-tool request`.",
    });
    return;
  }

  if (requestText.length > MAX_TOOL_REQUEST_CHARS) {
    await respond({
      text: `That tool request is ${requestText.length} characters. Please keep it under ${MAX_TOOL_REQUEST_CHARS} characters.`,
    });
    return;
  }

  logProgress("tools", "Running security review for tool customization request.");

  let review;
  try {
    review = await reviewToolCustomizationRequest(requestText, getActiveTools());
  } catch (error) {
    const failureReason = error.safeSummary || error.message || "Unknown error";
    console.error(
      `[ERROR] Tool customization review failed: ${failureReason}`,
    );
    review = {
      summary: `Automated review failed (${failureReason}). Manual source-code review required.`,
      recommendation: "needs_clarification",
      security_notes: [
        "Do not implement runtime code execution or arbitrary network calls from this request.",
      ],
      implementation_notes: [
        "Review server logs, define an allowlisted tool contract, then implement in source code.",
      ],
    };
  }
  review = normalizeToolReview(review);

  const allowedStatuses = new Set([
    "approve_for_coding",
    "needs_clarification",
    "reject",
  ]);
  const status = allowedStatuses.has(review.recommendation)
    ? review.recommendation
    : "needs_clarification";

  const requestId = createToolCustomizationRequest({
    userId,
    channelId,
    requestText,
    review,
    status,
  });

  logProgress(
    "tools",
    `Tool customization request #${requestId} saved with status ${status}.`,
  );

  await respond({
    text:
      `Tool customization request #${requestId} recorded.\n\n` +
      "Runtime tool creation from Slack is not enabled; this needs a source-code change so credentials, inputs, side effects, and network access can be reviewed properly.\n\n" +
      `Recommendation: ${status}\n` +
      `Summary: ${review.summary}\n\n` +
      "Security notes:\n" +
      formatReviewList(review.security_notes) +
      "\n\nImplementation notes:\n" +
      formatReviewList(review.implementation_notes),
  });
});

app.command("/ach-remove-tool", async ({ command, ack, respond }) => {
  await ack();
  logProgress("tools", "Remove-tool command acknowledged.");

  const { user_id: userId, user_name: username } = command;
  const text = (command.text || "").trim();
  const args = text.split(/\s+/).filter(Boolean);
  const subcommand = (args[0] || "help").toLowerCase();

  initUser(userId, username);

  if (subcommand === "help") {
    await respond({
      text:
        "Tool removal disables tools at runtime; it does not delete source code.\n\n" +
        "Usage:\n" +
        "- `/ach-remove-tool list`\n" +
        "- `/ach-remove-tool disable <tool_name>`\n" +
        "- `/ach-remove-tool enable <tool_name>`\n" +
        "- `/ach-remove-tool reset`\n\n" +
        "Known tools:\n" +
        formatToolsForSlack(),
    });
    return;
  }

  if (subcommand === "list") {
    await respond({
      text: "Known tools:\n" + formatToolsForSlack(),
    });
    return;
  }

  if (subcommand === "reset") {
    deleteSetting(DISABLED_TOOLS_SETTING_KEY);
    await respond({ text: "All tools have been re-enabled." });
    return;
  }

  if (subcommand !== "disable" && subcommand !== "enable") {
    await respond({
      text: "Unknown command. Try `/ach-remove-tool help`.",
    });
    return;
  }

  const toolName = args[1];
  if (!toolName || !getToolByName(toolName)) {
    await respond({
      text:
        "Please provide a known tool name.\n\nKnown tools:\n" +
        formatToolsForSlack(),
    });
    return;
  }

  const disabledToolNames = getDisabledToolNames();

  if (subcommand === "disable") {
    disabledToolNames.add(toolName);
    saveDisabledToolNames(disabledToolNames);
    await respond({
      text: `Tool disabled: ${toolName}. It will no longer be shown to the model or executed.`,
    });
    return;
  }

  disabledToolNames.delete(toolName);
  saveDisabledToolNames(disabledToolNames);
  await respond({
    text: `Tool enabled: ${toolName}.`,
  });
});

app.command("/ach-history", async ({ command, ack, respond }) => {
  await ack();
  logProgress("history", "History command acknowledged.");

  const { user_id: userId, user_name: username } = command;
  const text = (command.text || "").trim();
  const args = text.split(/\s+/).filter(Boolean);
  const subcommand = (args[0] || "help").toLowerCase();

  initUser(userId, username);

  if (subcommand === "help") {
    await respond({
      text:
        "Usage:\n" +
        "- `/ach-history list [limit]`\n" +
        "- `/ach-history list intent <intent> [limit]`\n" +
        "- `/ach-history show <message_id>`\n" +
        "- `/ach-history set <message_id> <new message text>`\n" +
        "- `/ach-history set-intent <message_id> <intent>`\n" +
        "- `/ach-history delete <message_id>`\n" +
        "- `/ach-history clear`\n" +
        "- `/ach-history clear intent <intent>`",
    });
    return;
  }

  if (subcommand === "list") {
    const { intent, limit } = parseHistoryListArgs(args.slice(1));
    const records = listChatHistory(userId, { intent, limit });
    await respond({
      text: slackCodeBlock(formatHistoryRecords(records)),
    });
    return;
  }

  if (subcommand === "show") {
    const messageId = args[1];
    const record = getChatHistoryRecord(userId, messageId);

    if (!record) {
      await respond({ text: `No chat history row found for #${messageId}.` });
      return;
    }

    await respond({
      text:
        `Chat history #${record.message_id}\n` +
        `Intent: ${record.intent}\n` +
        `Created: ${record.created_at}\n` +
        "Content:\n" +
        slackCodeBlock(record.message_content || ""),
    });
    return;
  }

  if (subcommand === "set") {
    const messageId = args[1];
    const nextContent = args.slice(2).join(" ").trim();

    if (!messageId || !nextContent) {
      await respond({
        text: "Usage: `/ach-history set <message_id> <new message text>`",
      });
      return;
    }

    const updated = updateChatHistoryRecord(userId, messageId, {
      messageContent: nextContent,
    });

    await respond({
      text: updated
        ? `Updated chat history #${messageId}.`
        : `No chat history row found for #${messageId}.`,
    });
    return;
  }

  if (subcommand === "set-intent") {
    const messageId = args[1];
    const nextIntent = args[2];

    if (!messageId || !nextIntent) {
      await respond({
        text: "Usage: `/ach-history set-intent <message_id> <intent>`",
      });
      return;
    }

    const updated = updateChatHistoryRecord(userId, messageId, {
      intent: nextIntent,
    });

    await respond({
      text: updated
        ? `Updated intent for chat history #${messageId} to ${nextIntent}.`
        : `No chat history row found for #${messageId}.`,
    });
    return;
  }

  if (subcommand === "delete") {
    const messageId = args[1];
    if (!messageId) {
      await respond({ text: "Usage: `/ach-history delete <message_id>`" });
      return;
    }

    const deletedCount = deleteChatHistoryRecord(userId, messageId);
    await respond({
      text: deletedCount
        ? `Deleted chat history #${messageId}.`
        : `No chat history row found for #${messageId}.`,
    });
    return;
  }

  if (subcommand === "clear") {
    const intent = args[1] === "intent" ? args[2] : null;
    const deletedCount = clearChatHistory(userId, intent);
    await respond({
      text: intent
        ? `Deleted ${deletedCount} chat history row(s) for intent ${intent}.`
        : `Deleted ${deletedCount} chat history row(s).`,
    });
    return;
  }

  await respond({ text: "Unknown command. Try `/ach-history help`." });
});

app.command("/ach-all-in", async ({ command, ack, respond, client }) => {
  await ack();
  logProgress("slack", "Command acknowledged.");

  const { user_id: userId, user_name: username, text: userQuery } = command;

  logProgress("user", `Ensuring user exists in database: ${userId}.`);
  initUser(userId, username);

  console.log(`\n--- NEW REQUEST ---`);
  console.log(
    `[DEBUG] Received request from ${userId} (${username}): "${userQuery}"`,
  );

  logProgress("intent", "Analyzing user message intent.");
  const { intent, summary } = await analyzeMessage(userQuery);
  console.log(`[DEBUG] Intent identified: [${intent}] | Summary: "${summary}"`);

  logProgress("context", "Collecting Slack context and same-intent history.");
  const channelContext = await getPreviousChannelMessages(
    client,
    command.channel_id,
  );
  const sameIntentHistory = getHistory(userId, intent, CONTEXT_MESSAGE_LIMIT);
  console.log(
    `[DEBUG] Fetched ${channelContext.length} previous Slack messages and ${sameIntentHistory.length} past interactions for intent '${intent}'.`,
  );

  logProgress("history", "Saving current request to chat history.");
  updateHistory(userId, {
    intent,
    summary,
    messageContent: userQuery,
  });

  logProgress("assistant", "Generating assistant reply and action plan.");
  const activeTools = getActiveTools();
  const { reply: assistantResponse, actions } = await processRequest(
    userQuery,
    intent,
    {
      channelContext,
      sameIntentHistory,
      availableTools: activeTools,
    },
  );

  console.log(`[DEBUG] Assistant raw reply: "${assistantResponse}"`);
  if (actions && actions.length > 0) {
    console.log(
      `[DEBUG] Actions to execute:`,
      JSON.stringify(actions, null, 2),
    );
  } else {
    console.log(`[DEBUG] No external actions to execute.`);
  }

  let finalResponse = assistantResponse;
  let actionResults = [];
  const activeToolNames = new Set(activeTools.map((tool) => tool.name));

  if (actions && actions.length > 0) {
    // Wait for all actions to execute
    logProgress("actions", `Executing ${actions.length} action(s).`);
    actionResults = await Promise.all(
      actions.map((action) => {
        if (!activeToolNames.has(action.action_name)) {
          return `Tool '${action.action_name}' is disabled or unavailable.`;
        }

        return executeAction(action);
      }),
    );
    console.log(`[DEBUG] Action results:`, actionResults);
  } else {
    logProgress("actions", "No actions to execute.");
  }

  // Format the final response using Reginald's personality
  logProgress("personality", "Formatting final response with personality.");
  console.log(`[DEBUG] Handing over to Reginald for personality formatting...`);
  const personalitySystemPrompt =
    getSetting(PERSONALITY_PROMPT_SETTING_KEY) || defaultPersonalitySystemPrompt;
  logProgress(
    "personality",
    `Using ${personalitySystemPrompt === defaultPersonalitySystemPrompt ? "default" : "custom"} personality prompt.`,
  );
  finalResponse = await formatWithPersonality(
    userQuery,
    assistantResponse,
    actionResults,
    { personalitySystemPrompt },
  );
  console.log(`[DEBUG] Final personalized response generated.`);

  logProgress("slack", "Sending final response back to Slack.");
  await respond({ text: finalResponse });
  logProgress("slack", "Response sent.");
  console.log(`--- END REQUEST ---\n`);
});

(async () => {
  await app.start();
  console.log("bot is running!");
})();

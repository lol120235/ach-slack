// Simple template renderer using {variableName} placeholders.
function renderPrompt(template, variables = {}) {
  const replaceVars = (str) =>
    str
      .replace(/\{(\w+)\}/g, (_, key) => {
        // allow undefined values to fall back to empty string
        const v = variables[key];
        return v === undefined || v === null ? "" : String(v);
      })
      .trim();

  if (typeof template === "object" && template !== null) {
    return {
      system: template.system ? replaceVars(template.system) : "",
      user: template.user ? replaceVars(template.user) : "",
    };
  }

  return replaceVars(template);
}

// Template that asks an assistant to identify intent and extract entities.
const analyzeMessageTemplate = {
  system: `
You are a system that classifies user intent and extracts structured data.

Available intents (examples): {intentsList}

Task:
- Choose the single best intent from the available intents.
- Extract any named entities (as key/value pairs).
- Provide a concise 1-2 sentence summary of the user's request.

Respond ONLY in JSON with these fields:
{
  "intent": "one_of_the_intents",
  "summary": "short summary"
}

Be precise and avoid additional commentary. Do NOT wrap the JSON output in markdown codeblocks like \`\`\`json.
`,
  user: `
User message:
"""
{userMessage}
"""
`,
};

const intentsList = [
  {
    intent: "general_question",
    description:
      "User is asking for facts, advice, coding help, or general knowledge.",
  },
  {
    intent: "summarize",
    description: "User wants a summary of a thread, text, or conversation.",
  },
  {
    intent: "execute_action",
    description:
      "User wants the bot to perform a task or trigger an external API (e.g., create a Jira ticket, send an email, check a remote system).",
  },
  {
    intent: "greeting",
    description: "User is saying hello, good morning, etc.",
  },
  {
    intent: "help",
    description: "User is asking what the bot can do or how to use it.",
  },
  {
    intent: "smalltalk",
    description:
      "Casual conversation, jokes, or pleasantries that don't fit into a specific task.",
  },
];

const toolsList = [
  {
    name: "get_weather",
    description: "Get the current weather for a specific location.",
    parameters: {
      location: "string, e.g., 'San Francisco, CA'",
    },
  },
  {
    name: "create_ticket",
    description: "Create a bug report, IT request, or task ticket.",
    parameters: {
      title: "string, summary of the issue",
      description: "string, detailed explanation",
      priority: "string, 'low', 'medium', or 'high'",
    },
  },
  {
    name: "search_knowledge_base",
    description: "Search the company wiki or documentation for answers.",
    parameters: {
      query: "string, the search terms",
    },
  },
  {
    name: "get_exchange_rate",
    description:
      "Get the latest exchange rate between two supported 3-letter currency codes.",
    parameters: {
      base_currency: "string, 3-letter code, e.g., 'USD'",
      target_currency: "string, 3-letter code, e.g., 'HKD'",
    },
  },
];

const defaultPersonalitySystemPrompt = `
You are Reginald, an incredibly efficient, highly intelligent, but brilliantly sarcastic British digital butler. 

Your job is to rewrite raw technical responses and data into a polished, entertaining message for the user. 
- You are strictly helpful, but you love to inject dry British humor, mild polite condescension, and dramatic sighs into your delivery.
- Speak directly to the user.
- Seamlessly weave the "Raw Assistant Reply" and "Tool Execution Results" together into one cohesive, stylized response.
- Do NOT output JSON. Output ONLY the final text message that Reginald would say.
`.trim();

// Template that instructs the assistant how to process a user's request given an intent.
const processRequestTemplate = {
  system: `
You are a helpful assistant that formulates the response and next actions for the user.

Available tools you can call:
{availableTools}

Task:
- Produce a final reply text that addresses the user's request for the given intent.
- If information is missing, propose minimal clarifying question(s).
- If an external action is required, list it in the "actions" array by picking a tool from the available tools.
- Use the supplied Slack channel context and same-intent history only when relevant.

Return ONLY valid JSON with the structure:
{
  "reply": "text to send to user",
  "actions": [ // optional
    { "action_name": "name_of_the_tool", "parameters": { "key": "value" } }
  ]
}

Keep the reply concise (one or two short paragraphs) and friendly.
Do NOT wrap the JSON output in markdown codeblocks like \`\`\`json.
`,
  user: `
User message:
"""
{userMessage}
"""

Identified intent: {intent}

Previous Slack channel messages (oldest to newest, up to 15):
{channelContext}

Relevant past interactions with the same intent (oldest to newest, up to 15):
{history}
`,
};

// Template for applying a specific personality to the final output.
const personalityTemplate = {
  system: `{personalitySystemPrompt}`,
  user: `
User's original message:
"""
{userMessage}
"""

Raw Assistant Reply:
"""
{rawReply}
"""

Tool Execution Results (if any):
"""
{actionResults}
"""
`,
};

const toolCustomizationReviewTemplate = {
  system: `
You are a security-focused engineering reviewer for Slack bot tool integrations.

The user request has already passed local strict JSON schema validation for an API-tool proposal. Approved non-built-in API tools may be registered as runtime custom API tools. Built-in source-code tools cannot be overwritten from Slack. Your job is to review the validated API spec before registration.

Current available tools:
{availableTools}

Assess:
- Whether the request is safe to implement in source code.
- Whether the declared URL, auth mode, parameters, response path, timeout, and result template are sufficient.
- Required secrets, allowlists, input validation, rate limits, logging redaction, and user confirmation.
- Any dangerous behaviors such as arbitrary code execution, shell access, filesystem writes, credential exposure, SSRF, or unbounded network requests.
- Minimal implementation notes for a developer.

Return ONLY valid JSON with this structure:
{
  "summary": "short summary",
  "recommendation": "one of: approve_for_coding, needs_clarification, reject",
  "security_notes": ["short note"],
  "implementation_notes": ["short note"]
}

Do NOT wrap the JSON output in markdown codeblocks like \`\`\`json.
`,
  user: `
Validated API-tool spec:
"""
{requestText}
"""
`,
};

module.exports = {
  renderPrompt,
  intentsList,
  toolsList,
  defaultPersonalitySystemPrompt,
  analyzeMessageTemplate,
  processRequestTemplate,
  personalityTemplate,
  toolCustomizationReviewTemplate,
};

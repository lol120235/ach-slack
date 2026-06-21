const axios = require("axios");
const net = require("node:net");
const {
  renderPrompt,
  analyzeMessageTemplate,
  intentsList,
  processRequestTemplate,
  personalityTemplate,
  defaultPersonalitySystemPrompt,
  toolCustomizationReviewTemplate,
  toolsList,
} = require("./prompts");

const API_URL = process.env.LLM_BASE_URL;
const API_KEY = process.env.LLM_API_KEY;
const LOG_PROMPTS = process.env.LOG_PROMPTS !== "false";
const FAST_MODEL = process.env.FAST_MODEL;
const ACCURATE_MODEL = process.env.ACCURATE_MODEL;
const EXCHANGE_RATE_TIMEOUT_MS = 5000;
const EXCHANGE_RATE_MIN_INTERVAL_MS = 1000;
const CUSTOM_API_TOOL_MIN_INTERVAL_MS = 1000;
const SUPPORTED_EXCHANGE_RATE_CURRENCIES = new Set([
  "AED",
  "AFN",
  "ALL",
  "AMD",
  "ANG",
  "AOA",
  "ARS",
  "AUD",
  "AWG",
  "AZN",
  "BAM",
  "BBD",
  "BDT",
  "BHD",
  "BIF",
  "BMD",
  "BND",
  "BOB",
  "BRL",
  "BSD",
  "BTN",
  "BWP",
  "BYN",
  "BZD",
  "CAD",
  "CDF",
  "CHF",
  "CLP",
  "CNH",
  "CNY",
  "COP",
  "CRC",
  "CUP",
  "CVE",
  "CZK",
  "DJF",
  "DKK",
  "DOP",
  "DZD",
  "EGP",
  "ERN",
  "ETB",
  "EUR",
  "FJD",
  "FKP",
  "GBP",
  "GEL",
  "GGP",
  "GHS",
  "GIP",
  "GMD",
  "GNF",
  "GTQ",
  "GYD",
  "HKD",
  "HNL",
  "HTG",
  "HUF",
  "IDR",
  "ILS",
  "IMP",
  "INR",
  "IQD",
  "IRR",
  "ISK",
  "JEP",
  "JMD",
  "JOD",
  "JPY",
  "KES",
  "KGS",
  "KHR",
  "KMF",
  "KPW",
  "KRW",
  "KWD",
  "KYD",
  "KZT",
  "LAK",
  "LBP",
  "LKR",
  "LRD",
  "LSL",
  "LYD",
  "MAD",
  "MDL",
  "MGA",
  "MKD",
  "MMK",
  "MNT",
  "MOP",
  "MRO",
  "MRU",
  "MUR",
  "MVR",
  "MWK",
  "MXN",
  "MYR",
  "MZN",
  "NAD",
  "NGN",
  "NIO",
  "NOK",
  "NPR",
  "NZD",
  "OMR",
  "PAB",
  "PEN",
  "PGK",
  "PHP",
  "PKR",
  "PLN",
  "PYG",
  "QAR",
  "RON",
  "RSD",
  "RUB",
  "RWF",
  "SAR",
  "SBD",
  "SCR",
  "SDG",
  "SEK",
  "SGD",
  "SHP",
  "SLE",
  "SOS",
  "SRD",
  "SSP",
  "STN",
  "SVC",
  "SYP",
  "SZL",
  "THB",
  "TJS",
  "TMT",
  "TND",
  "TOP",
  "TRY",
  "TTD",
  "TWD",
  "TZS",
  "UAH",
  "UGX",
  "USD",
  "UYU",
  "UZS",
  "VES",
  "VND",
  "VUV",
  "WST",
  "XAF",
  "XAG",
  "XAU",
  "XCD",
  "XCG",
  "XDR",
  "XOF",
  "XPD",
  "XPF",
  "XPT",
  "YER",
  "ZAR",
  "ZMW",
  "ZWG",
]);
let lastExchangeRateRequestAt = 0;
const lastCustomApiToolRequestAt = new Map();

const ANALYZE_MESSAGE_SCHEMA = `
{
  "intent": "one of the available intents",
  "summary": "short summary"
}
`.trim();

const PROCESS_REQUEST_SCHEMA = `
{
  "reply": "text to send to user",
  "actions": [
    { "action_name": "name_of_the_tool", "parameters": { "key": "value" } }
  ]
}
`.trim();

const TOOL_CUSTOMIZATION_REVIEW_SCHEMA = `
{
  "summary": "short summary",
  "recommendation": "approve_for_coding | needs_clarification | reject",
  "security_notes": ["short note"],
  "implementation_notes": ["short note"]
}
`.trim();

function logPromptMessages(label, messages) {
  if (!LOG_PROMPTS) return;

  console.log(`\n[PROMPT:${label}] BEGIN`);
  messages.forEach((message, index) => {
    console.log(`[PROMPT:${label}] Message ${index + 1} (${message.role})`);
    console.log(message.content);
  });
  console.log(`[PROMPT:${label}] END\n`);
}

function stripJsonFences(response) {
  return String(response || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractBalancedJsonObject(response) {
  const text = stripJsonFences(response);
  const startIndex = text.indexOf("{");
  if (startIndex === -1) return text;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return text.slice(startIndex, index + 1);
    }
  }

  return text;
}

function parseJsonResponse(response, requestName) {
  const cleanedResponse = extractBalancedJsonObject(response);

  try {
    return JSON.parse(cleanedResponse);
  } catch (error) {
    console.error(`[ERROR] Failed to parse ${requestName} JSON:`, response);
    throw error;
  }
}

function buildJsonRepairMessages(requestName, response, schemaDescription) {
  return [
    {
      role: "system",
      content:
        "You repair malformed model output into valid JSON. Output exactly one JSON object and nothing else. Do not use markdown. Do not explain.",
    },
    {
      role: "user",
      content: `
Task name: ${requestName}

Required schema:
${schemaDescription}

Malformed output:
"""
${response}
"""
`,
    },
  ];
}

async function parseJsonResponseWithRepair({
  response,
  requestName,
  model,
  schemaDescription,
}) {
  try {
    return parseJsonResponse(response, requestName);
  } catch (error) {
    console.warn(
      `[WARN] ${requestName} returned malformed JSON. Attempting one JSON repair pass.`,
    );
  }

  const repairMessages = buildJsonRepairMessages(
    requestName,
    response,
    schemaDescription,
  );
  logPromptMessages(`${requestName}:jsonRepair`, repairMessages);

  const repairedResponse = await generateResponse(repairMessages, {
    model,
    requestName: `${requestName}:jsonRepair`,
    temperature: 0,
  });

  console.log(`[DEBUG] ${requestName} repaired JSON response: ${repairedResponse}`);

  return parseJsonResponse(repairedResponse, `${requestName}:jsonRepair`);
}

function normalizeAnalyzeMessageResult(result) {
  return {
    intent: typeof result.intent === "string" ? result.intent : "general_question",
    summary: typeof result.summary === "string" ? result.summary : "",
  };
}

function normalizeProcessRequestResult(result) {
  return {
    reply: typeof result.reply === "string" ? result.reply : "",
    actions: Array.isArray(result.actions) ? result.actions : [],
  };
}

function normalizeToolCustomizationReviewResult(result) {
  return {
    summary: typeof result.summary === "string" ? result.summary : "",
    recommendation:
      typeof result.recommendation === "string"
        ? result.recommendation
        : "needs_clarification",
    security_notes: Array.isArray(result.security_notes)
      ? result.security_notes
      : [],
    implementation_notes: Array.isArray(result.implementation_notes)
      ? result.implementation_notes
      : [],
  };
}

function summarizeRequestError(error) {
  if (error.response) {
    const status = error.response.status;
    const statusText = error.response.statusText || "Request failed";
    const responseData = error.response.data;
    const detail =
      typeof responseData === "string"
        ? responseData.trim()
        : responseData && (responseData.title || responseData.error);

    return detail
      ? `${status} ${statusText}: ${detail}`
      : `${status} ${statusText}`;
  }

  if (error.request) {
    return error.code
      ? `${error.code}: No response received`
      : "No response received";
  }

  return error.message || "Unknown error";
}

function normalizeExchangeCurrencyCode(value) {
  const code = String(value || "")
    .trim()
    .toUpperCase();

  if (!/^[A-Z]{3}$/.test(code)) return null;
  if (!SUPPORTED_EXCHANGE_RATE_CURRENCIES.has(code)) return null;

  return code;
}

function isPrivateOrLocalIp(hostname) {
  const ipVersion = net.isIP(hostname);
  if (!ipVersion) return false;

  if (ipVersion === 6) {
    const normalizedHost = hostname.toLowerCase();
    return (
      normalizedHost === "::1" ||
      normalizedHost.startsWith("fc") ||
      normalizedHost.startsWith("fd") ||
      normalizedHost.startsWith("fe80:")
    );
  }

  const [first, second] = hostname.split(".").map(Number);
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function assertSafeCustomApiUrl(url) {
  const parsedUrl = new URL(url);

  if (parsedUrl.protocol !== "https:") {
    throw new Error("Custom API tool URLs must use HTTPS.");
  }

  if (
    parsedUrl.hostname === "localhost" ||
    parsedUrl.hostname.endsWith(".localhost") ||
    isPrivateOrLocalIp(parsedUrl.hostname)
  ) {
    throw new Error("Custom API tool URL targets a blocked host.");
  }
}

function normalizeCustomApiParameterValue(name, parameterSpec, rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    if (parameterSpec.required) {
      throw new Error(`Missing required parameter: ${name}.`);
    }

    return undefined;
  }

  let value = rawValue;

  if (parameterSpec.type === "string") {
    value = String(rawValue);

    if (parameterSpec.pattern && !new RegExp(parameterSpec.pattern).test(value)) {
      throw new Error(`Parameter ${name} does not match its required pattern.`);
    }

    if (parameterSpec.enum && !parameterSpec.enum.includes(value)) {
      throw new Error(`Parameter ${name} is not an allowed value.`);
    }
  } else if (parameterSpec.type === "number") {
    value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw new Error(`Parameter ${name} must be a number.`);
    }
  } else if (parameterSpec.type === "integer") {
    value = Number(rawValue);
    if (!Number.isInteger(value)) {
      throw new Error(`Parameter ${name} must be an integer.`);
    }
  } else if (parameterSpec.type === "boolean") {
    if (typeof rawValue === "boolean") {
      value = rawValue;
    } else if (rawValue === "true") {
      value = true;
    } else if (rawValue === "false") {
      value = false;
    } else {
      throw new Error(`Parameter ${name} must be true or false.`);
    }
  }

  if (
    parameterSpec.min !== undefined &&
    typeof value === "number" &&
    value < parameterSpec.min
  ) {
    throw new Error(`Parameter ${name} must be at least ${parameterSpec.min}.`);
  }

  if (
    parameterSpec.max !== undefined &&
    typeof value === "number" &&
    value > parameterSpec.max
  ) {
    throw new Error(`Parameter ${name} must be at most ${parameterSpec.max}.`);
  }

  return value;
}

function normalizeCustomApiParameters(spec, parameters = {}) {
  return Object.entries(spec.parameters || {}).reduce(
    (normalizedParameters, [name, parameterSpec]) => {
      const value = normalizeCustomApiParameterValue(
        name,
        parameterSpec,
        parameters[name],
      );

      if (value !== undefined) {
        normalizedParameters[name] = value;
      }

      return normalizedParameters;
    },
    {},
  );
}

function buildCustomApiUrl(spec, parameters) {
  let url = spec.url;
  const consumedParameters = new Set();

  Object.entries(parameters).forEach(([name, value]) => {
    const placeholder = `{${name}}`;
    if (url.includes(placeholder)) {
      url = url.replaceAll(placeholder, encodeURIComponent(String(value)));
      consumedParameters.add(name);
    }
  });

  const parsedUrl = new URL(url);
  if (spec.method === "GET") {
    Object.entries(parameters).forEach(([name, value]) => {
      if (!consumedParameters.has(name)) {
        parsedUrl.searchParams.set(name, String(value));
      }
    });
  }

  assertSafeCustomApiUrl(parsedUrl.href);

  return {
    url: parsedUrl.href,
    bodyParameters: Object.fromEntries(
      Object.entries(parameters).filter(([name]) => !consumedParameters.has(name)),
    ),
  };
}

function applyCustomApiAuth(spec, requestConfig) {
  const auth = spec.auth || { type: "none" };
  if (auth.type === "none") return;

  const secret = process.env[auth.env_var];
  if (!secret) {
    throw new Error(`Missing required environment variable: ${auth.env_var}.`);
  }

  if (auth.type === "bearer_env") {
    requestConfig.headers[auth.name] = `Bearer ${secret}`;
    return;
  }

  if (auth.location === "header") {
    requestConfig.headers[auth.name] = secret;
    return;
  }

  requestConfig.params = {
    ...(requestConfig.params || {}),
    [auth.name]: secret,
  };
}

function getResponsePathValue(data, path) {
  const segments = [];
  String(path).replace(/([^[.\]]+)|\[(\d+)\]/g, (_, property, index) => {
    segments.push(property !== undefined ? property : Number(index));
  });

  return segments.reduce((value, segment) => {
    if (value === undefined || value === null) return undefined;
    return value[segment];
  }, data);
}

function renderCustomApiResultTemplate(template, values) {
  return String(template).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, key) => {
    const value = values[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

async function generateResponse(messages, options = {}) {
  const {
    temperature = 0.7,
    model = ACCURATE_MODEL,
    requestName = "llm",
  } = options;

  console.log(
    `[PROGRESS] Sending ${requestName} request to ${model} (temperature: ${temperature}).`,
  );

  try {
    const response = await axios.post(
      API_URL,
      {
        model: model,
        messages: messages,
        temperature: temperature,
      },
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );

    const content = response.data.choices[0].message.content;
    console.log(
      `[PROGRESS] ${requestName} response received (${content.length} chars).`,
    );

    return content;
  } catch (error) {
    const safeSummary = summarizeRequestError(error);
    error.safeSummary = safeSummary;
    console.error(`[ERROR] ${requestName} request failed: ${safeSummary}`);
    throw error;
  }
}

async function analyzeMessage(userMessage) {
  const rendered = renderPrompt(analyzeMessageTemplate, {
    userMessage,
    intentsList: JSON.stringify(intentsList),
  });

  const messages = [
    { role: "system", content: rendered.system },
    { role: "user", content: rendered.user },
  ];

  logPromptMessages("analyzeMessage", messages);

  const model = FAST_MODEL;
  const response = await generateResponse(messages, {
    model: FAST_MODEL,
    requestName: "analyzeMessage",
    temperature: 0.2,
  });

  console.log(`[DEBUG] analyzeMessage raw response: ${response}`);

  const messageAnalysis = await parseJsonResponseWithRepair({
    response,
    requestName: "analyzeMessage",
    model,
    schemaDescription: ANALYZE_MESSAGE_SCHEMA,
  });

  return normalizeAnalyzeMessageResult(messageAnalysis);
}

function formatRecords(records, emptyMessage, formatter) {
  if (!Array.isArray(records) || records.length === 0) {
    return emptyMessage;
  }

  return records.map(formatter).join("\n");
}

function formatSlackContext(messages) {
  return formatRecords(
    messages,
    "No previous Slack channel messages available.",
    (message, index) => {
      const sender = message.sender ? `${message.sender}: ` : "";
      return `${index + 1}. ${sender}${message.text}`;
    },
  );
}

function formatSameIntentHistory(chatHistory) {
  return formatRecords(
    chatHistory,
    "No past interactions with this intent.",
    (record, index) => {
      const timestamp = record.created_at ? ` (${record.created_at})` : "";
      return `${index + 1}.${timestamp} ${record.message_content}`;
    },
  );
}

async function processRequest(userMessage, intent, context = {}) {
  const normalizedContext = Array.isArray(context)
    ? { sameIntentHistory: context, channelContext: [] }
    : context;
  const availableTools = normalizedContext.availableTools || toolsList;

  const formattedHistory = formatSameIntentHistory(
    normalizedContext.sameIntentHistory,
  );
  const formattedChannelContext = formatSlackContext(
    normalizedContext.channelContext,
  );

  const rendered = renderPrompt(processRequestTemplate, {
    userMessage,
    intent,
    history: formattedHistory,
    channelContext: formattedChannelContext,
    availableTools: JSON.stringify(availableTools, null, 2),
  });

  const messages = [
    { role: "system", content: rendered.system },
    { role: "user", content: rendered.user },
  ];

  logPromptMessages("processRequest", messages);

  const model = ACCURATE_MODEL;
  const response = await generateResponse(messages, {
    model: ACCURATE_MODEL,
    requestName: "processRequest",
    temperature: 0.2,
  });

  console.log(`[DEBUG] processRequest raw response: ${response}`);

  const processResult = await parseJsonResponseWithRepair({
    response,
    requestName: "processRequest",
    model,
    schemaDescription: PROCESS_REQUEST_SCHEMA,
  });

  return normalizeProcessRequestResult(processResult);
}

async function executeAction(action) {
  const { action_name, parameters } = action;

  console.log(`Executing tool: ${action_name}`, parameters);

  try {
    switch (action_name) {
      case "get_weather": {
        // Using wttr.in, a free weather API that requires no API key and supports location names natively
        const location = encodeURIComponent(parameters.location);
        const { data } = await axios.get(
          `https://wttr.in/${location}?format=j1`,
        );
        const current = data.current_condition[0];
        return `Weather for ${parameters.location}: ${current.temp_C}°C (${current.temp_F}°F) and ${current.weatherDesc[0].value}.`;
      }

      case "create_ticket": {
        // Using JSONPlaceholder to simulate creating a record in a remote system
        const { data } = await axios.post(
          "https://jsonplaceholder.typicode.com/posts",
          {
            title: parameters.title,
            body: parameters.description,
            userId: 1, // mock user
          },
        );
        return `Ticket created successfully. ID: #TICKET-${data.id}`;
      }

      case "search_knowledge_base": {
        // Using Wikipedia's free Search API as a mock knowledge base
        const query = encodeURIComponent(parameters.query);
        const { data } = await axios.get(
          `https://en.wikipedia.org/w/api.php?action=opensearch&search=${query}&limit=3&format=json`,
        );
        const titles = data[1];
        const links = data[3];

        if (titles.length === 0)
          return `No documents found for "${parameters.query}".`;

        const results = titles
          .map((title, i) => `- ${title}: ${links[i]}`)
          .join("\\n");
        return `Found ${titles.length} relevant documents:\\n${results}`;
      }

      case "get_exchange_rate": {
        const baseCurrency = normalizeExchangeCurrencyCode(
          parameters.base_currency,
        );
        const targetCurrency = normalizeExchangeCurrencyCode(
          parameters.target_currency,
        );

        if (!baseCurrency || !targetCurrency) {
          return "Please provide supported 3-letter currency codes, for example USD and HKD.";
        }

        if (baseCurrency === targetCurrency) {
          return `1 ${baseCurrency} = 1 ${targetCurrency}.`;
        }

        const now = Date.now();
        if (now - lastExchangeRateRequestAt < EXCHANGE_RATE_MIN_INTERVAL_MS) {
          return "The exchange-rate tool is being called too quickly. Please try again in a moment.";
        }
        lastExchangeRateRequestAt = now;

        const { data } = await axios.get(
          `https://api.frankfurter.dev/v2/rate/${baseCurrency}/${targetCurrency}`,
          { timeout: EXCHANGE_RATE_TIMEOUT_MS },
        );

        if (typeof data.rate !== "number") {
          return `No exchange rate found for ${baseCurrency} to ${targetCurrency}.`;
        }

        return `1 ${baseCurrency} = ${data.rate} ${targetCurrency} as of ${data.date}.`;
      }

      default:
        console.warn(`Unknown action requested: ${action_name}`);
        return `Error: Tool '${action_name}' is not implemented.`;
    }
  } catch (error) {
    console.error(`Error executing ${action_name}:`, error.message);
    return `Failed to execute ${action_name}. Please try again later.`;
  }
}

async function executeCustomApiTool(action, spec) {
  const { action_name, parameters } = action;
  console.log(`Executing custom API tool: ${action_name}`, parameters);

  try {
    const now = Date.now();
    const lastRequestAt = lastCustomApiToolRequestAt.get(spec.name) || 0;
    if (now - lastRequestAt < CUSTOM_API_TOOL_MIN_INTERVAL_MS) {
      return `Tool '${spec.name}' is being called too quickly. Please try again in a moment.`;
    }
    lastCustomApiToolRequestAt.set(spec.name, now);

    const normalizedParameters = normalizeCustomApiParameters(
      spec,
      parameters,
    );
    const { url, bodyParameters } = buildCustomApiUrl(
      spec,
      normalizedParameters,
    );
    const requestConfig = {
      method: spec.method,
      url,
      timeout: spec.timeout_ms,
      headers: {},
    };

    applyCustomApiAuth(spec, requestConfig);

    if (spec.method === "POST") {
      requestConfig.data = bodyParameters;
    }

    const { data } = await axios.request(requestConfig);
    const result = getResponsePathValue(data, spec.response_path);

    if (result === undefined || result === null) {
      return `Tool '${spec.name}' did not find a result at response_path '${spec.response_path}'.`;
    }

    return renderCustomApiResultTemplate(spec.result_template, {
      ...normalizedParameters,
      result,
      rate: result,
      date: data && data.date,
    });
  } catch (error) {
    if (
      /^Missing required parameter: /.test(error.message) ||
      /^Parameter .+ (does not match|is not|must be)/.test(error.message)
    ) {
      return error.message;
    }

    console.error(
      `Error executing custom API tool ${action_name}:`,
      summarizeRequestError(error),
    );
    return `Failed to execute custom tool '${action_name}'. Please try again later.`;
  }
}

async function reviewToolCustomizationRequest(requestText, availableTools = toolsList) {
  const rendered = renderPrompt(toolCustomizationReviewTemplate, {
    requestText,
    availableTools: JSON.stringify(availableTools, null, 2),
  });

  const messages = [
    { role: "system", content: rendered.system },
    { role: "user", content: rendered.user },
  ];

  logPromptMessages("reviewToolCustomizationRequest", messages);

  const model = FAST_MODEL;
  const response = await generateResponse(messages, {
    model: FAST_MODEL,
    requestName: "reviewToolCustomizationRequest",
    temperature: 0.2,
  });

  console.log(
    `[DEBUG] reviewToolCustomizationRequest raw response: ${response}`,
  );

  const reviewResult = await parseJsonResponseWithRepair({
    response,
    requestName: "reviewToolCustomizationRequest",
    model,
    schemaDescription: TOOL_CUSTOMIZATION_REVIEW_SCHEMA,
  });

  return normalizeToolCustomizationReviewResult(reviewResult);
}

async function formatWithPersonality(
  userMessage,
  rawReply,
  actionResults,
  options = {},
) {
  const rendered = renderPrompt(personalityTemplate, {
    personalitySystemPrompt:
      options.personalitySystemPrompt || defaultPersonalitySystemPrompt,
    userMessage,
    rawReply,
    actionResults: actionResults ? actionResults.join("\n") : "None",
  });

  const messages = [
    { role: "system", content: rendered.system },
    { role: "user", content: rendered.user },
  ];

  logPromptMessages("formatWithPersonality", messages);

  const response = await generateResponse(messages, {
    model: FAST_MODEL, // Using a faster, cheaper model for simple formatting
    requestName: "formatWithPersonality",
  });

  return response;
}

module.exports = {
  generateResponse,
  analyzeMessage,
  processRequest,
  executeAction,
  executeCustomApiTool,
  reviewToolCustomizationRequest,
  formatWithPersonality,
};

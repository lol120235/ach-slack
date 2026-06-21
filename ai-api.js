const axios = require("axios");
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

function logPromptMessages(label, messages) {
  if (!LOG_PROMPTS) return;

  console.log(`\n[PROMPT:${label}] BEGIN`);
  messages.forEach((message, index) => {
    console.log(`[PROMPT:${label}] Message ${index + 1} (${message.role})`);
    console.log(message.content);
  });
  console.log(`[PROMPT:${label}] END\n`);
}

function parseJsonResponse(response, requestName) {
  const cleanedResponse = response
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return JSON.parse(cleanedResponse);
  } catch (error) {
    console.error(`[ERROR] Failed to parse ${requestName} JSON:`, response);
    throw error;
  }
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

  const response = await generateResponse(messages, {
    model: FAST_MODEL,
    requestName: "analyzeMessage",
  });

  console.log(`[DEBUG] analyzeMessage raw response: ${response}`);

  const messageAnalysis = parseJsonResponse(response, "analyzeMessage");

  return messageAnalysis;
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

  const response = await generateResponse(messages, {
    model: ACCURATE_MODEL,
    requestName: "processRequest",
  });

  console.log(`[DEBUG] processRequest raw response: ${response}`);

  return parseJsonResponse(response, "processRequest");
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

  const response = await generateResponse(messages, {
    model: FAST_MODEL,
    requestName: "reviewToolCustomizationRequest",
    temperature: 0.2,
  });

  console.log(
    `[DEBUG] reviewToolCustomizationRequest raw response: ${response}`,
  );

  return parseJsonResponse(response, "reviewToolCustomizationRequest");
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
  reviewToolCustomizationRequest,
  formatWithPersonality,
};

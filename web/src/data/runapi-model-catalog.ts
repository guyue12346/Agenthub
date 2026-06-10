export interface RunApiModelCatalogItem {
  id: string;
  vendor: string;
  tags: string;
  groups: string[];
  endpoints: string[];
  promptRatio: number;
  completionRatio: number;
  unitPrice: number;
}

export interface RunApiGroupCatalogItem {
  key: string;
  label: string;
  description: string;
  ratio: number;
}

export const RUNAPI_BASE_URL = "https://runapi.co/v1";
export const RUNAPI_CATALOG_SOURCE = "https://runapi.co/api/pricing";
export const RUNAPI_CATALOG_UPDATED_AT = "2026-06-03";

export const RUNAPI_GROUPS = [
  {
    "key": "Plus",
    "label": "Plus",
    "description": "Plus高级分组",
    "ratio": 1.5
  },
  {
    "key": "claude-0.8",
    "label": "claude-0.8",
    "description": "claude-0.8",
    "ratio": 1
  },
  {
    "key": "claude_normal",
    "label": "claude_normal",
    "description": "claude常规(openclaw可用)",
    "ratio": 0.5
  },
  {
    "key": "codex",
    "label": "codex",
    "description": "codex pro号池",
    "ratio": 0.25
  },
  {
    "key": "coding",
    "label": "coding",
    "description": "ccmax(限制claudecode客户端)",
    "ratio": 0.5
  },
  {
    "key": "default",
    "label": "default",
    "description": "官方直连,包含gpt,gemini,claude等所有模型",
    "ratio": 1
  },
  {
    "key": "discounts",
    "label": "discounts",
    "description": "Gemini折扣分组",
    "ratio": 0.5
  },
  {
    "key": "kiro",
    "label": "kiro",
    "description": "kiro",
    "ratio": 1
  }
] satisfies RunApiGroupCatalogItem[];

export const RUNAPI_TEXT_MODEL_CATALOG = [
  {
    "id": "kimi-k2",
    "vendor": "Moonshot",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.22,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "kimi-k2-thinking",
    "vendor": "Moonshot",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.22857,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "kimi-k2.5",
    "vendor": "Moonshot",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.22857,
    "completionRatio": 5.25,
    "unitPrice": 0
  },
  {
    "id": "kimi-k2.6",
    "vendor": "Moonshot",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.371428,
    "completionRatio": 4.153846,
    "unitPrice": 0
  },
  {
    "id": "gpt-4",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 2.9,
    "completionRatio": 2,
    "unitPrice": 0
  },
  {
    "id": "gpt-4.1",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 0.4,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "gpt-4.1-mini",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 0.08,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "gpt-4.1-nano",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 0.02,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "gpt-4o",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "Plus",
      "default"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 0.5,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "gpt-4o-mini",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 0.03,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "gpt-5",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 0.25,
    "completionRatio": 8,
    "unitPrice": 0
  },
  {
    "id": "gpt-5-mini",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 0.05,
    "completionRatio": 8,
    "unitPrice": 0
  },
  {
    "id": "gpt-5-nano",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 0.01,
    "completionRatio": 8,
    "unitPrice": 0
  },
  {
    "id": "gpt-5-pro",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai-response"
    ],
    "promptRatio": 3,
    "completionRatio": 8,
    "unitPrice": 0
  },
  {
    "id": "gpt-5.1",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 0.25,
    "completionRatio": 8,
    "unitPrice": 0
  },
  {
    "id": "gpt-5.2",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "codex",
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 0.35,
    "completionRatio": 8,
    "unitPrice": 0
  },
  {
    "id": "gpt-5.2-codex",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "codex"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 0.35,
    "completionRatio": 8,
    "unitPrice": 0
  },
  {
    "id": "gpt-5.2-pro",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "Plus"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 4.2,
    "completionRatio": 8,
    "unitPrice": 0
  },
  {
    "id": "gpt-5.3-codex",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "codex"
    ],
    "endpoints": [
      "openai-response",
      "openai"
    ],
    "promptRatio": 0.35,
    "completionRatio": 8,
    "unitPrice": 0
  },
  {
    "id": "gpt-5.4",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "codex",
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 0.5,
    "completionRatio": 6,
    "unitPrice": 0
  },
  {
    "id": "gpt-5.4-mini",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "codex",
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai-response",
      "openai"
    ],
    "promptRatio": 0.15,
    "completionRatio": 6,
    "unitPrice": 0
  },
  {
    "id": "gpt-5.4-nano",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 0.04,
    "completionRatio": 6,
    "unitPrice": 0
  },
  {
    "id": "gpt-5.4-pro",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai-response"
    ],
    "promptRatio": 6,
    "completionRatio": 6,
    "unitPrice": 0
  },
  {
    "id": "gpt-5.5",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "codex",
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 1,
    "completionRatio": 8,
    "unitPrice": 0
  },
  {
    "id": "gpt-oss-120b",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.22,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "gpt-oss-20b",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.04,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "o1",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 4.8,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "o1-mini",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 0.319,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "o1-pro",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "Plus"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 75,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "o3",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "openai-response"
    ],
    "promptRatio": 0.6,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "o3-deep-research",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "Plus"
    ],
    "endpoints": [
      "openai-response"
    ],
    "promptRatio": 5,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "o3-mini",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai-response",
      "openai"
    ],
    "promptRatio": 0.32,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "o3-pro",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai-response"
    ],
    "promptRatio": 6,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "o4-mini",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai-response",
      "openai"
    ],
    "promptRatio": 0.32,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "o4-mini-deep-research",
    "vendor": "OpenAI",
    "tags": "Text Generation",
    "groups": [
      "Plus"
    ],
    "endpoints": [
      "openai-response"
    ],
    "promptRatio": 1,
    "completionRatio": 1,
    "unitPrice": 0
  },
  {
    "id": "claude-haiku-4-5-20251001",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "claude_normal",
      "claude-0.8",
      "coding",
      "default",
      "kiro",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 0.3,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-haiku-4-5-20251001-thinking",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "coding",
      "default",
      "kiro",
      "Plus",
      "claude_normal",
      "claude-0.8"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 0.3,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-opus-4-1-20250805",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "claude-0.8",
      "coding",
      "default",
      "kiro",
      "Plus",
      "claude_normal"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 4.5,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-opus-4-1-20250805-thinking",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "claude_normal",
      "claude-0.8",
      "coding",
      "default",
      "kiro",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 4.5,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-opus-4-20250514",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "kiro",
      "Plus",
      "claude_normal",
      "claude-0.8",
      "coding",
      "default"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 4.5,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-opus-4-20250514-thinking",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "claude_normal",
      "claude-0.8",
      "coding",
      "default",
      "kiro",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 4.5,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-opus-4-5-20251101",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "claude_normal",
      "claude-0.8",
      "coding",
      "default",
      "kiro",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 1.5,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-opus-4-5-20251101-thinking",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "kiro",
      "Plus",
      "claude_normal",
      "claude-0.8",
      "coding",
      "default"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 1.5,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-opus-4-6",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "Plus",
      "claude_normal",
      "claude-0.8",
      "coding",
      "default",
      "kiro"
    ],
    "endpoints": [
      "anthropic",
      "openai"
    ],
    "promptRatio": 1.5,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-opus-4-6-thinking",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "claude_normal",
      "claude-0.8",
      "coding",
      "default",
      "kiro",
      "Plus"
    ],
    "endpoints": [
      "anthropic",
      "openai"
    ],
    "promptRatio": 1.5,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-opus-4-7",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "claude_normal",
      "coding",
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 1.5,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-opus-4-8",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "claude_normal",
      "coding",
      "default",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 1.5,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-sonnet-4-20250514",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "claude-0.8",
      "coding",
      "default",
      "kiro",
      "Plus",
      "claude_normal"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 0.9,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-sonnet-4-20250514-thinking",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "coding",
      "default",
      "kiro",
      "Plus",
      "claude_normal",
      "claude-0.8"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 0.9,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-sonnet-4-5-20250929",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "claude_normal",
      "claude-0.8",
      "coding",
      "default",
      "kiro",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 0.9,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-sonnet-4-5-20250929-thinking",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "default",
      "kiro",
      "Plus",
      "claude_normal",
      "claude-0.8",
      "coding"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 0.9,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-sonnet-4-6",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "Plus",
      "claude_normal",
      "claude-0.8",
      "coding",
      "default",
      "kiro"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 0.9,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "claude-sonnet-4-6-thinking",
    "vendor": "Anthropic",
    "tags": "Text Generation",
    "groups": [
      "coding",
      "default",
      "kiro",
      "Plus",
      "claude_normal",
      "claude-0.8"
    ],
    "endpoints": [
      "openai",
      "anthropic"
    ],
    "promptRatio": 0.9,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "gemini-2.5-flash",
    "vendor": "Google",
    "tags": "Text Generation",
    "groups": [
      "default",
      "discounts",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "gemini"
    ],
    "promptRatio": 0.0643,
    "completionRatio": 8.34,
    "unitPrice": 0
  },
  {
    "id": "gemini-2.5-flash-lite",
    "vendor": "Google",
    "tags": "Text Generation",
    "groups": [
      "default",
      "discounts",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "gemini"
    ],
    "promptRatio": 0.0215,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "gemini-2.5-pro",
    "vendor": "Google",
    "tags": "Text Generation",
    "groups": [
      "default",
      "discounts",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "gemini"
    ],
    "promptRatio": 0.27,
    "completionRatio": 8,
    "unitPrice": 0
  },
  {
    "id": "gemini-3-flash-preview",
    "vendor": "Google",
    "tags": "Text Generation",
    "groups": [
      "Plus",
      "default",
      "discounts"
    ],
    "endpoints": [
      "openai",
      "gemini"
    ],
    "promptRatio": 0.11,
    "completionRatio": 6,
    "unitPrice": 0
  },
  {
    "id": "gemini-3-pro-preview",
    "vendor": "Google",
    "tags": "Text Generation",
    "groups": [
      "default",
      "discounts",
      "Plus"
    ],
    "endpoints": [
      "openai",
      "gemini"
    ],
    "promptRatio": 0.43,
    "completionRatio": 6,
    "unitPrice": 0
  },
  {
    "id": "gemini-3.1-pro-preview",
    "vendor": "Google",
    "tags": "Text Generation",
    "groups": [
      "default",
      "discounts",
      "Plus"
    ],
    "endpoints": [
      "gemini",
      "openai"
    ],
    "promptRatio": 0.43,
    "completionRatio": 6,
    "unitPrice": 0
  },
  {
    "id": "gemini-3.5-flash",
    "vendor": "Google",
    "tags": "Text Generation",
    "groups": [
      "default",
      "discounts",
      "Plus"
    ],
    "endpoints": [
      "gemini",
      "openai"
    ],
    "promptRatio": 0.315,
    "completionRatio": 6,
    "unitPrice": 0
  },
  {
    "id": "deepseek-chat",
    "vendor": "DeepSeek",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.09,
    "completionRatio": 1.5,
    "unitPrice": 0
  },
  {
    "id": "deepseek-ocr",
    "vendor": "DeepSeek",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0,
    "completionRatio": 0,
    "unitPrice": 0.016
  },
  {
    "id": "deepseek-r1",
    "vendor": "DeepSeek",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.228571,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "deepseek-r1-searching",
    "vendor": "DeepSeek",
    "tags": "Text Generation,Web Search",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.183,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "deepseek-reasoner",
    "vendor": "DeepSeek",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.183,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "deepseek-v3",
    "vendor": "DeepSeek",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.114285,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "deepseek-v3-1",
    "vendor": "DeepSeek",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.228571,
    "completionRatio": 3,
    "unitPrice": 0
  },
  {
    "id": "deepseek-v3.1-thinking",
    "vendor": "DeepSeek",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.183,
    "completionRatio": 3,
    "unitPrice": 0
  },
  {
    "id": "deepseek-v3.2",
    "vendor": "DeepSeek",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.114285,
    "completionRatio": 1.5,
    "unitPrice": 0
  },
  {
    "id": "deepseek-v3.2-speciale",
    "vendor": "DeepSeek",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.0812,
    "completionRatio": 1.5,
    "unitPrice": 0
  },
  {
    "id": "deepseek-v3.2-thinking",
    "vendor": "DeepSeek",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.09,
    "completionRatio": 1.5,
    "unitPrice": 0
  },
  {
    "id": "deepseek-v4-flash",
    "vendor": "DeepSeek",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.057143,
    "completionRatio": 2,
    "unitPrice": 0
  },
  {
    "id": "deepseek-v4-pro",
    "vendor": "DeepSeek",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.685714,
    "completionRatio": 2,
    "unitPrice": 0
  },
  {
    "id": "grok-3",
    "vendor": "xAI",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.88,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "grok-3-deepsearch",
    "vendor": "xAI",
    "tags": "Text Generation,Web Search",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.87,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "grok-3-reasoner",
    "vendor": "xAI",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.87,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "grok-4",
    "vendor": "xAI",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.87,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "grok-4-fast",
    "vendor": "xAI",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.058,
    "completionRatio": 2.5,
    "unitPrice": 0
  },
  {
    "id": "grok-4.1",
    "vendor": "xAI",
    "tags": "Text Generation,Web Search",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.36,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "grok-4.1-fast",
    "vendor": "xAI",
    "tags": "Text Generation,Web Search",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.058,
    "completionRatio": 7.5,
    "unitPrice": 0
  },
  {
    "id": "grok-4.2",
    "vendor": "xAI",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.36,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "qwen-max",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 20,
    "completionRatio": 1,
    "unitPrice": 0
  },
  {
    "id": "qwen-plus",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.08,
    "completionRatio": 2.5,
    "unitPrice": 0
  },
  {
    "id": "qwen-turbo",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.07,
    "completionRatio": 2,
    "unitPrice": 0
  },
  {
    "id": "qwen2.5-72b-instruct",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.1624,
    "completionRatio": 3,
    "unitPrice": 0
  },
  {
    "id": "qwen2.5-7b-instruct",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.02,
    "completionRatio": 2,
    "unitPrice": 0
  },
  {
    "id": "qwen3-14b",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.045,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "qwen3-235b-a22b",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.0812,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "qwen3-235b-a22b-thinking-2507",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.09,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "qwen3-30b-a3b",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.1,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "qwen3-32b",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.0812,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "qwen3-8b",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.1,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "qwen3-coder-plus",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.1624,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "qwen3-max",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.142857,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "qwen3-vl-235b-a22b-instruct",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.0812,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "qwen3-vl-235b-a22b-thinking",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.0812,
    "completionRatio": 10,
    "unitPrice": 0
  },
  {
    "id": "qwen3-vl-flash",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.008571,
    "completionRatio": 10,
    "unitPrice": 0
  },
  {
    "id": "qwen3-vl-plus",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.057142,
    "completionRatio": 10,
    "unitPrice": 0
  },
  {
    "id": "qwen3.5-122b-a10b",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.2,
    "completionRatio": 8,
    "unitPrice": 0
  },
  {
    "id": "qwen3.5-27b",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.1,
    "completionRatio": 8,
    "unitPrice": 0
  },
  {
    "id": "qwen3.5-35b-a3b",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.09,
    "completionRatio": 8,
    "unitPrice": 0
  },
  {
    "id": "qwen3.5-397b-a17b",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.2,
    "completionRatio": 6,
    "unitPrice": 0
  },
  {
    "id": "qwen3.5-flash",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.011428,
    "completionRatio": 10,
    "unitPrice": 0
  },
  {
    "id": "qwen3.5-plus",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.045714,
    "completionRatio": 6,
    "unitPrice": 0
  },
  {
    "id": "qwen3.6-flash",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.068571,
    "completionRatio": 6,
    "unitPrice": 0
  },
  {
    "id": "qwen3.6-max",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.514285,
    "completionRatio": 6,
    "unitPrice": 0
  },
  {
    "id": "qwen3.6-plus",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.114285,
    "completionRatio": 6,
    "unitPrice": 0
  },
  {
    "id": "qwen3.7-max",
    "vendor": "Alibaba",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.685714,
    "completionRatio": 3,
    "unitPrice": 0
  },
  {
    "id": "doubao-seed-1-6-251015",
    "vendor": "ByteDance",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.05,
    "completionRatio": 10,
    "unitPrice": 0
  },
  {
    "id": "doubao-seed-1-6-flash-250828",
    "vendor": "ByteDance",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.0164,
    "completionRatio": 1,
    "unitPrice": 0
  },
  {
    "id": "doubao-seed-1-6-thinking-250715",
    "vendor": "ByteDance",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.05,
    "completionRatio": 10,
    "unitPrice": 0
  },
  {
    "id": "doubao-seed-1-6-vision-250815",
    "vendor": "ByteDance",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.0875,
    "completionRatio": 8,
    "unitPrice": 0
  },
  {
    "id": "doubao-seed-1-8-251228",
    "vendor": "ByteDance",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.0857,
    "completionRatio": 10,
    "unitPrice": 0
  },
  {
    "id": "doubao-seed-1-8-251228-thinking",
    "vendor": "ByteDance",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.0857,
    "completionRatio": 10,
    "unitPrice": 0
  },
  {
    "id": "doubao-seed-2-0-code-preview-260215",
    "vendor": "ByteDance",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.3429,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "doubao-seed-2-0-lite-260215",
    "vendor": "ByteDance",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.0643,
    "completionRatio": 6,
    "unitPrice": 0
  },
  {
    "id": "doubao-seed-2-0-mini-260215",
    "vendor": "ByteDance",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.0214,
    "completionRatio": 10,
    "unitPrice": 0
  },
  {
    "id": "doubao-seed-2-0-pro-260215",
    "vendor": "ByteDance",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.3429,
    "completionRatio": 5,
    "unitPrice": 0
  },
  {
    "id": "glm-4.5",
    "vendor": "Zhipu",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.171428,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "glm-4.6",
    "vendor": "Zhipu",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.171428,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "glm-4.6-thinking",
    "vendor": "Zhipu",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.214,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "glm-4.7",
    "vendor": "Zhipu",
    "tags": "Text Generation ",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.171428,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "glm-5",
    "vendor": "Zhipu",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.228571,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "glm-5.1",
    "vendor": "Zhipu",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.342857,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "llama-3-sonar-large-32k-chat",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.1,
    "completionRatio": 1,
    "unitPrice": 0
  },
  {
    "id": "llama-3-sonar-small-32k-chat",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.1,
    "completionRatio": 1,
    "unitPrice": 0
  },
  {
    "id": "meta-llama/llama-3-70b-instruct",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.2,
    "completionRatio": 1.4,
    "unitPrice": 0
  },
  {
    "id": "meta-llama/llama-3-8b-instruct",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.02,
    "completionRatio": 2,
    "unitPrice": 0
  },
  {
    "id": "meta-llama/llama-3.1-405b",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 2.5,
    "completionRatio": 1,
    "unitPrice": 0
  },
  {
    "id": "meta-llama/llama-3.1-405b-instruct",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 3,
    "completionRatio": 1,
    "unitPrice": 0
  },
  {
    "id": "meta-llama/llama-3.1-70b-instruct",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.25,
    "completionRatio": 1,
    "unitPrice": 0
  },
  {
    "id": "meta-llama/llama-3.1-8b-instruct",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.015,
    "completionRatio": 1.5,
    "unitPrice": 0
  },
  {
    "id": "meta-llama/llama-3.2-11b-vision-instruct",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.03,
    "completionRatio": 1,
    "unitPrice": 0
  },
  {
    "id": "meta-llama/llama-3.2-1b-instruct",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.015,
    "completionRatio": 7.5,
    "unitPrice": 0
  },
  {
    "id": "meta-llama/llama-3.2-3b-instruct",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.015,
    "completionRatio": 1,
    "unitPrice": 0
  },
  {
    "id": "meta-llama/llama-3.2-90b-vision-instruct",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.2,
    "completionRatio": 1.15,
    "unitPrice": 0
  },
  {
    "id": "meta-llama/llama-3.3-70b-instruct",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.6,
    "completionRatio": 3.2,
    "unitPrice": 0
  },
  {
    "id": "meta-llama/llama-4-maverick",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.1,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "meta-llama/llama-4-scout",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.06,
    "completionRatio": 3.75,
    "unitPrice": 0
  },
  {
    "id": "meta-llama/llama-guard-4-12b",
    "vendor": "Meta",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.1,
    "completionRatio": 1,
    "unitPrice": 0
  },
  {
    "id": "MiniMax-M2.5",
    "vendor": "Minimax",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.12,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "MiniMax-M2.7",
    "vendor": "Minimax",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.12,
    "completionRatio": 4,
    "unitPrice": 0
  },
  {
    "id": "minimax-m2.1",
    "vendor": "Minimax",
    "tags": "Text Generation",
    "groups": [
      "default"
    ],
    "endpoints": [
      "openai"
    ],
    "promptRatio": 0.12,
    "completionRatio": 4,
    "unitPrice": 0
  }
] satisfies RunApiModelCatalogItem[];

export function findRunApiModel(modelId: string) {
  return RUNAPI_TEXT_MODEL_CATALOG.find((model) => model.id === modelId);
}

export function preferredRunApiWireApi(modelId: string): "responses" | "chat_completions" {
  const model = findRunApiModel(modelId);
  if (model?.endpoints.includes("openai-response") && !model.endpoints.includes("openai")) return "responses";
  return "chat_completions";
}

import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const baseURL = process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1';
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL || 'qwen/qwen3-30b-a3b';
const timeout = Number(process.env.LLM_TIMEOUT_MS || 30000);
const qwenNoThink = /qwen/i.test(model) ? ' /no_think' : '';

if (!apiKey) {
  console.error(JSON.stringify({ ok: false, error: 'LLM_API_KEY is not configured' }));
  process.exit(2);
}

try {
  const client = new OpenAI({
    baseURL,
    apiKey,
    timeout,
    defaultHeaders: {
      'HTTP-Referer': 'http://localhost',
      'X-Title': 'ASA Challenge 2 validation preflight',
    },
  });
  const started = Date.now();
  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 16,
    messages: [{ role: 'user', content: `Reply exactly with OK.${qwenNoThink}` }],
  });
  const text = response.choices?.[0]?.message?.content ?? '';
  const responseReceived = text.trim().length > 0;
  console.log(JSON.stringify({
    ok: responseReceived,
    model,
    baseUrlConfigured: Boolean(baseURL),
    latency_ms: Date.now() - started,
    responseReceived,
  }));
  if (!responseReceived) process.exit(1);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    model,
    baseUrlConfigured: Boolean(baseURL),
    error: error?.message ?? String(error),
  }));
  process.exit(1);
}

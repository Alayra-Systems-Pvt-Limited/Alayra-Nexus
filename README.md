# Kinetic Nexus

**One endpoint. Every AI provider. No rate limits.**

Kinetic Nexus is a self-hosted AI proxy that pools your Claude, Gemini, GPT, Groq, and OpenRouter keys behind a single OpenAI-compatible endpoint. Point Cursor, Continue.dev, or any AI tool at it and run unlimited parallel agents without hitting rate limits.

## How it works

1. You add your API keys (Claude, Gemini, GPT, etc.) through the admin API
2. Kinetic Nexus generates **one URL** and **one API key** for you
3. Paste those into Cursor (or any tool) as Custom AI
4. Nexus routes each request to the least-used key automatically
5. Track token usage, cost, and model breakdown in the dashboard

## Quick start (Docker — 1 command)

```bash
# 1. Clone
git clone https://github.com/your-org/kinetic-nexus
cd kinetic-nexus

# 2. Generate encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Create .env
cp .env.example .env
# Edit .env — set MASTER_ENCRYPTION_KEY and ADMIN_PASSWORD

# 4. Start
docker compose up -d

# 5. Your API key is printed in the logs on first run:
docker compose logs nexus | grep "Nexus API Key"
```

Your proxy is now running at `http://localhost:3000`.

## Add to Cursor

1. Open Cursor Settings → Models → Add Custom Model
2. Set **Base URL**: `http://localhost:3000/v1`
3. Set **API Key**: (the key printed in logs)
4. Set **Model**: `nexus-auto` (routes to best available) or any specific model ID

Now every Cursor agent uses your pooled keys — 30 agents = 30 simultaneous requests across all your providers.

## Add API keys via admin

```bash
# Add a provider (e.g. Anthropic)
curl -X POST http://localhost:3000/admin/providers \
  -H "Authorization: Bearer YOUR_ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"name":"Anthropic","slug":"anthropic","provider":"anthropic"}'

# Add a key to it
curl -X POST http://localhost:3000/admin/providers/PROVIDER_ID/keys \
  -H "Authorization: Bearer YOUR_ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"sk-ant-...","label":"Key 1","rpmLimit":60}'
```

Add as many keys as you have — Nexus rotates automatically.

## Usage dashboard

```bash
# Today's usage
curl http://localhost:3000/admin/usage?period=today \
  -H "Authorization: Bearer YOUR_ADMIN_PASSWORD"

# 30-day breakdown by model
curl http://localhost:3000/admin/usage?period=30d \
  -H "Authorization: Bearer YOUR_ADMIN_PASSWORD"
```

## Supported providers

| Provider   | Auto base URL | Notes |
|------------|--------------|-------|
| anthropic  | api.anthropic.com | Claude 3.5, 3 Opus, etc. |
| openai     | api.openai.com | GPT-4o, o1, etc. |
| google     | generativelanguage.googleapis.com | Gemini 2.0, 1.5, etc. |
| groq       | api.groq.com | Llama, Mixtral — ultra fast |
| openrouter | openrouter.ai | 100+ models, one key |
| custom     | your URL | Any OpenAI-compatible endpoint |

## API reference

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /v1/chat/completions` | Nexus API key | OpenAI-compatible proxy |
| `GET /v1/models` | Nexus API key | List active models |
| `GET /admin/status` | Admin password | Health + key count |
| `GET /admin/providers` | Admin password | List providers |
| `POST /admin/providers` | Admin password | Add provider |
| `POST /admin/providers/:id/keys` | Admin password | Add key |
| `POST /admin/keys/:id/test` | Admin password | Test key latency |
| `POST /admin/keys/:id/ban` | Admin password | Ban a key |
| `GET /admin/usage` | Admin password | Token usage summary |
| `GET /admin/models` | Admin password | Model registry |
| `PUT /admin/models` | Admin password | Update model registry |
| `POST /admin/api-key/regenerate` | Admin password | Rotate proxy API key |

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `MASTER_ENCRYPTION_KEY` | Yes | 64 hex chars — encrypts stored API keys |
| `ADMIN_PASSWORD` | Yes | Password for admin endpoints |
| `PORT` | No | Default: 3000 |

## License

MIT

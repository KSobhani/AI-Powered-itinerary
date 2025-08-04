# AI-Powered Itinerary Generator

This project is a serverless application that accepts a user request, uses a Large Language Model (LLM) to generate a structured travel itinerary, and saves the result to Firestore. It's built with Cloudflare Workers, OpenAI GPT-4o, and Firestore REST API.

---

## Features

* Cloudflare Worker API endpoint (POST + GET)
* Asynchronous itinerary generation using GPT-4o
* Firestore integration using REST API + JWT
* Secrets handled securely with Wrangler
* Structured JSON output
* Zod validation
* Automatic retries
* Configurable via environment variables
---

## Front-end UI

A simple Svelte UI is included for checking the status of any `jobId` and viewing the final itinerary. This UI is deployed separately via Cloudflare Pages.

---

## Deployment URLs

| Component          | URL                                                             |
|--------------------|-----------------------------------------------------------------|
| Worker API         | [https://itinerary-generator-production.ai-powered.workers.dev] |
| Status Checker UI  | [https://ai-powered-itinerary.pages.dev]                                   |

---

## Data Model

Documents in the `itineraries` collection use the following schema:

```jsonc
{
  "status": "processing" | "completed" | "failed",
  "destination": "Paris, France",
  "durationDays": 3,
  "createdAt": <Firestore Timestamp>,
  "completedAt": <Firestore Timestamp | null>,
  "itinerary": [
    {
      "day": 1,
      "theme": "Historical Paris",
      "activities": [
        {
          "time": "Morning",
          "description": "Visit the Louvre Museum. Pre‑book tickets to avoid queues.",
          "location": "Louvre Museum"
        },
        // …
      ]
    }
  ],
  "error": "Error message if status is 'failed', otherwise null"
}
```

## Project Structure

```
/
└── src/
    └── worker.js       # Cloudflare Worker code
├── ui/                 # Svelte UI code for status checker
├── wrangler.toml       # Worker config
├── package.json        # Dependencies and scripts
├── .gitignore          # Ignore node_modules, .env, etc.
```

---

## Setup Instructions

### 1. Clone and install

```bash
git clone https://github.com/KSobhani/ai-itinerary-worker.git
cd ai-itinerary-worker
npm install
```

### 2. Configure Secrets

This app uses the following environment variables (secrets):

| Name                    | Description                      |
| ----------------------- | -------------------------------- |
| `OPENAI_API_KEY`        | Your OpenAI API key              |
| `FIREBASE_PROJECT_ID`   | Firebase project ID              |
| `FIREBASE_CLIENT_EMAIL` | Service account email            |
| `FIREBASE_PRIVATE_KEY`  | Private key from service account |

Use `wrangler` to securely add these secrets:

```bash
npx wrangler secret put OPENAI_API_KEY --env=production
npx wrangler secret put FIREBASE_PROJECT_ID --env=production
npx wrangler secret put FIREBASE_CLIENT_EMAIL --env=production
npx wrangler secret put FIREBASE_PRIVATE_KEY --env=production
```

Note: Replace `--env=production` with `--env=""` if you are deploying to the default environment.

### 3. Deploy

```bash
npx wrangler deploy --env=production
```
## Deploy UI on Cloudflare Pages

```bash
cd ui
npm install
npm run build
npx npx wrangler pages deploy .svelte-kit/output/client --project-name=ai-powered-itinerary
```
---

## API Usage

### POST `/`

Submit a travel request:

```bash
curl -X POST "https://itinerary-generator-production.ai-powered.workers.dev" \
  -H "Content-Type: application/json" \
  -d '{"destination": "Tokyo, Japan", "durationDays": 3}'
```

```cmd
curl -X POST "https://itinerary-generator-production.ai-powered.workers.dev" -H "Content-Type: application/json" -d "{\"destination\": \"Paris, France\", \"durationDays\": 2}"
```
Response:

```json
{
  "jobId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

### GET `/?jobId=...`

Check status of the itinerary:

```bash
curl "https://itinerary-generator-production.ai-powered.workers.dev/?jobId=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Response example:

```json
{
  "jobId": "...",
  "status": "completed",
  "destination": "Tokyo, Japan",
  "durationDays": 3,
  "createdAt": "...",
  "completedAt": "...",
  "itinerary": [...],
  "error": null
}
```

---

## Prompt Design

The LLM prompt instructs GPT-4o to:

* Generate a multi-day itinerary with 3 activities per day
* Return output **strictly as a JSON object** (no extra text)
* Each activity includes `time`, `description`, and `location`

Example system prompt:

> "You are a helpful travel planning assistant. Return only valid JSON, no markdown or commentary."

---

## Firestore Data Model

Each document in the `itineraries` collection looks like:

```json
{
  "status": "completed",
  "destination": "Paris, France",
  "durationDays": 3,
  "createdAt": "...",
  "completedAt": "...",
  "itinerary": [ ... ],
  "error": null
}
```

---

## Security Notes

* Secrets are managed via Wrangler and never committed.
* Firestore access is authenticated via signed JWT using a service account.
* Firestore security rules should allow only service account writes/reads.

---

## Architectural Choices

* Used REST API for Firestore to stay compatible with Cloudflare Workers (no firebase-admin)
* Asynchronous LLM call handled with `ctx.waitUntil()` for fast response
* Simple JSON schema to avoid parsing errors and keep LLM output reliable

---

## Implemented Improvements

**Zod Validation** : Validates LLM responses to ensure they match the expected itinerary schema. Invalid responses are logged as status: "failed" in Firestore with a detailed error message.
**Automatic Retries** : Implements retry with exponential backoff (1s, 2s, 4s delays with jitter) for OpenAI API errors (429, 5xx). Up to 3 retries are attempted before marking the job as failed.
**Svelte UI** : A Svelte-based UI deployed on Cloudflare Pages to check itinerary status using the Worker’s GET endpoint.

---

## Author

Developed for Stak.ai Technical Assessment — 2025.

Contact: [kosarsobhani.work@gmail.com](mailto:kosarsobhani.work@gmail.com)  
GitHub: [KSobhani](https://github.com/KSobhani)

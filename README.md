# FamilyTripAI

An AI travel-planning assistant for families. Users chat about a trip and the
agent plans it end to end — flights, hotels, weather, activities, restaurants,
travel tips, currency and a day-by-day itinerary — using tool calls against free
public APIs, with a Groq-hosted Llama model doing the reasoning.

## Architecture

There are **two implementations** of the same app. To avoid the two drifting
apart, treat the Cloudflare Worker as the source of truth.

| File(s) | Role | Status |
| --- | --- | --- |
| `worker.js` | Self-contained Cloudflare Worker — serves the SPA (HTML/CSS/JS inlined) and handles `/chat` + `/search`. Uses `llama-3.1-8b-instant`. | **Deployed** (`wrangler.toml` → `main = worker.js`) |
| `app.py`, `agent.py`, `tools.py` | FastAPI backend serving `static/index.html`. Uses `llama-3.3-70b-versatile`. | Local/dev alternative, kept in prompt parity with the Worker |

The user supplies their own free [Groq API key](https://console.groq.com),
stored client-side; no server-side key is required.

## Running

**Cloudflare Worker (deployed app):**

```bash
npm install        # installs wrangler if not already present
npm run dev        # local dev server
npm run deploy     # deploy to Cloudflare
```

**FastAPI backend (alternative):**

```bash
pip install -r requirements.txt
uvicorn app:app --reload        # serves static/index.html on :8000
```

## Tests

```bash
npm test           # node --test — covers the Worker's pure helpers
```

Tests cover the SSE stream parser, booking-link builders, the TTL cache, and
the tool status strings. They run without network access.

## Recent improvements

- **Real token streaming.** The chat now forwards Groq's SSE content deltas to
  the browser as they're generated, instead of waiting for the full response and
  replaying it with a fake typewriter. See `callGroqStream` in `worker.js`.
- **In-isolate caching.** Geocoding, weather and FX lookups are memoised with a
  TTL (`memoJson`) so repeat lookups in a session don't re-hit the public APIs.
- **Shared booking-link builders.** `buildFlightLinks` / `buildHotelLinks` are
  used by both the chat tools and the `/search` browsing API, so the deep-links
  can't drift between the two code paths.
- **Prompt parity.** `agent.py` and `worker.js` now share the same system-prompt
  guidance (activity-specific logistics, always finish with a written summary).

## Known limitations / not yet built

These need external credentials or paid services and are intentionally **not**
wired up yet:

- **Authentication is cosmetic.** The Google/Apple buttons don't perform real
  OAuth; profile, account and chat history live in `localStorage` only, so they
  don't follow the user across devices. Real auth needs an OAuth client (or
  Cloudflare Access) plus a server-side store (KV/D1).
- **Flight/hotel/activity prices are illustrative, not live.** The Trips / Prices
  / For Me tabs ask the model to generate *plausible* example listings (clearly
  labelled as estimates). Real numbers require a paid inventory API (Amadeus,
  Skyscanner, Booking affiliate, etc.) and its API key.
- **Web search is limited** to DuckDuckGo's instant-answer endpoint, which is
  often empty for travel queries. Richer results would need a search API key.

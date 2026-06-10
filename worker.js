// FamilyTripAI — Cloudflare Worker
// Serves the SPA HTML and handles /chat by calling Groq API directly.

// ─── Model configuration ─────────────────────────────────────────────────────
// Centralised so the model is changed in one place. CHAT_MODEL drives the
// agent's reasoning/itinerary turns; SEARCH_MODEL backs the structured
// browsing extraction (Trips/Prices/For Me). Kept on the fast instant model by
// default to stay under the free-tier tokens-per-minute cap.
const CHAT_MODEL = 'llama-3.1-8b-instant';
const SEARCH_MODEL = 'llama-3.1-8b-instant';

// ─── Shared fetch helper ─────────────────────────────────────────────────────
// External data APIs (search, geocoding, weather, currency) are flaky and can
// hang. Wrap them with a timeout (via AbortController) and a couple of retries
// with exponential backoff so a single slow/failed upstream doesn't break a tool.
async function fetchWithRetry(url, options = {}, { timeoutMs = 8000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      // Retry transient upstream errors; return everything else to the caller.
      if (!res.ok && res.status >= 500 && attempt < retries) {
        await new Promise(r => setTimeout(r, 400 * Math.pow(2, attempt)));
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 400 * Math.pow(2, attempt)));
        continue;
      }
    }
  }
  throw lastErr || new Error('Request failed');
}

// ─── Tool implementations (all async, using fetch) ───────────────────────────

async function toolWebSearch(query, maxResults = 5) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'FamilyTripAI/1.0' } });
    const data = await res.json();

    const lines = [];
    if (data.AbstractText) {
      lines.push(`${data.AbstractText}`);
      if (data.AbstractURL) lines.push(`Source: ${data.AbstractURL}`);
    }
    const topics = (data.RelatedTopics || []).slice(0, maxResults);
    for (const t of topics) {
      if (t.Text) {
        lines.push(`\n${t.Text}`);
        if (t.FirstURL) lines.push(`Link: ${t.FirstURL}`);
      } else if (t.Topics) {
        for (const sub of t.Topics.slice(0, 2)) {
          if (sub.Text) lines.push(`\n${sub.Text}`);
        }
      }
    }
    return lines.length > 0
      ? lines.join('\n')
      : `No instant results for: ${query}. Try searching at https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  } catch (e) {
    return `Web search error: ${e.message}`;
  }
}

async function toolWeather(location, days = 7) {
  try {
    const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
    const geoRes = await fetchWithRetry(geoUrl, { headers: { 'User-Agent': 'FamilyTripAI/1.0' } });
    const geoData = await geoRes.json();
    if (!geoData || geoData.length === 0) return `Location "${location}" not found.`;

    const { lat, lon, display_name } = geoData[0];
    const forecastDays = Math.min(parseInt(days) || 7, 16);
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_mean,weathercode&timezone=auto&forecast_days=${forecastDays}`;
    const wRes = await fetchWithRetry(weatherUrl);
    const wData = await wRes.json();
    const daily = wData.daily;

    const wmo = {
      0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
      45: 'Foggy', 48: 'Icy fog', 51: 'Light drizzle', 53: 'Moderate drizzle',
      55: 'Heavy drizzle', 61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
      71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
      80: 'Slight showers', 81: 'Moderate showers', 82: 'Heavy showers',
      95: 'Thunderstorm', 99: 'Heavy thunderstorm with hail'
    };

    const lines = [`Weather forecast for ${display_name} (${forecastDays} days):`];
    for (let i = 0; i < daily.time.length; i++) {
      const code = daily.weathercode[i];
      const desc = wmo[code] || `Code ${code}`;
      const rain = daily.precipitation_probability_mean[i];
      const hi = daily.temperature_2m_max[i];
      const lo = daily.temperature_2m_min[i];
      lines.push(`${daily.time[i]}: ${desc} | High ${hi}C / Low ${lo}C | Rain chance ${rain}%`);
    }
    return lines.join('\n');
  } catch (e) {
    return `Weather error: ${e.message}`;
  }
}

async function toolFlights(origin, destination, departureDate, returnDate = '', passengers = 1) {
  const googleUrl = `https://www.google.com/travel/flights?q=flights+from+${encodeURIComponent(origin)}+to+${encodeURIComponent(destination)}+${departureDate}`;
  const skyscannerUrl = `https://www.skyscanner.com/transport/flights/${encodeURIComponent(origin.toLowerCase())}/${encodeURIComponent(destination.toLowerCase())}/${(departureDate || '').replace(/-/g, '')}`;
  const kayakUrl = `https://www.kayak.com/flights/${encodeURIComponent(origin)}-${encodeURIComponent(destination)}/${departureDate}${returnDate ? '/' + returnDate : ''}/${passengers}adults`;

  let result = `Flights: ${origin} to ${destination}\n`;
  result += `Departure: ${departureDate}${returnDate ? ' | Return: ' + returnDate : ''} | Passengers: ${passengers}\n\n`;
  result += `Book here:\n`;
  result += `- Google Flights: ${googleUrl}\n`;
  result += `- Skyscanner: ${skyscannerUrl}\n`;
  result += `- Kayak: ${kayakUrl}\n\n`;

  const searchResult = await toolWebSearch(`cheap flights ${origin} to ${destination} ${departureDate} ${passengers} passengers family`, 4);
  result += `Search results:\n${searchResult}`;
  return result;
}

async function toolHotels(location, checkin, checkout, guests = 2, rooms = 1) {
  const bookingUrl = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(location)}&checkin=${checkin}&checkout=${checkout}&group_adults=${guests}&no_rooms=${rooms}`;
  const airbnbUrl = `https://www.airbnb.com/s/${encodeURIComponent(location)}/homes?checkin=${checkin}&checkout=${checkout}&adults=${guests}`;
  const hotelsUrl = `https://www.hotels.com/search.do?q-destination=${encodeURIComponent(location)}&q-check-in=${checkin}&q-check-out=${checkout}&q-rooms=${rooms}&q-room-0-adults=${guests}`;

  let result = `Hotels in ${location}\n`;
  result += `Check-in: ${checkin} | Check-out: ${checkout} | Guests: ${guests} | Rooms: ${rooms}\n\n`;
  result += `Book here:\n`;
  result += `- Booking.com: ${bookingUrl}\n`;
  result += `- Airbnb: ${airbnbUrl}\n`;
  result += `- Hotels.com: ${hotelsUrl}\n\n`;

  const searchResult = await toolWebSearch(`best family hotels ${location} kids amenities pool`, 4);
  result += `Search results:\n${searchResult}`;
  return result;
}

async function toolDestinationImage(location) {
  const prompt = encodeURIComponent(`stunning travel destination ${location} beautiful landscape family vacation photorealistic golden hour`);
  const imageUrl = `https://image.pollinations.ai/prompt/${prompt}?width=900&height=450&nologo=true&seed=42`;
  return JSON.stringify({ image_url: imageUrl, location, type: 'destination_image' });
}

async function toolCurrency(from, to) {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  try {
    const res = await fetchWithRetry(`https://open.er-api.com/v6/latest/${f}`);
    const data = await res.json();
    const rate = data.rates && data.rates[t];
    if (rate == null) throw new Error('rate unavailable');
    return `1 ${f} = ${rate} ${t} (live mid-market rate)`;
  } catch (e1) {
    try {
      const res2 = await fetchWithRetry(`https://api.frankfurter.dev/v1/latest?base=${f}&symbols=${t}`);
      const data2 = await res2.json();
      const rate2 = data2.rates && data2.rates[t];
      if (rate2 == null) throw new Error('rate unavailable');
      return `1 ${f} = ${rate2} ${t} (European Central Bank)`;
    } catch (e2) {
      return `Currency error: ${e2.message}`;
    }
  }
}

async function toolActivities(location, activityType = 'family', numResults = 6) {
  return toolWebSearch(`best ${activityType} activities things to do ${location} kids children`, numResults);
}

async function toolRestaurants(location, cuisine = '', familyFriendly = true) {
  const tag = familyFriendly ? 'family friendly' : 'best';
  return toolWebSearch(`${tag} ${cuisine} restaurants ${location} kids children menu`, 6);
}

async function toolTips(destination, month = '') {
  return toolWebSearch(`family travel tips ${destination} ${month} visa requirements safety kids packing`, 5);
}

async function toolTransport(location) {
  return toolWebSearch(`getting around ${location} public transport taxi family tips`, 4);
}

// ─── Tool definitions for Groq tool calling ──────────────────────────────────

const TOOLS_DEF = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information about any topic',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'integer', default: 5 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather forecast for a travel destination',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City or destination name' },
          days: { type: 'integer', description: 'Forecast days (max 16)', default: 7 }
        },
        required: ['location']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_flights',
      description: 'Search for flights and provide booking links',
      parameters: {
        type: 'object',
        properties: {
          origin: { type: 'string', description: 'Departure city or airport' },
          destination: { type: 'string', description: 'Destination city or airport' },
          departure_date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
          return_date: { type: 'string', description: 'Return date YYYY-MM-DD', default: '' },
          passengers: { type: 'integer', description: 'Total number of passengers', default: 1 }
        },
        required: ['origin', 'destination', 'departure_date']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_hotels',
      description: 'Search for family hotels and provide booking links',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string' },
          checkin: { type: 'string', description: 'Check-in date YYYY-MM-DD' },
          checkout: { type: 'string', description: 'Check-out date YYYY-MM-DD' },
          guests: { type: 'integer', default: 2 },
          rooms: { type: 'integer', default: 1 }
        },
        required: ['location', 'checkin', 'checkout']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'destination_image',
      description: 'Generate a beautiful image of a travel destination',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'Destination name to visualize' }
        },
        required: ['location']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'currency_info',
      description: 'Get live currency exchange rates',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source currency code e.g. USD' },
          to: { type: 'string', description: 'Target currency code e.g. EUR' }
        },
        required: ['from', 'to']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_activities',
      description: 'Find activities and attractions for families at a destination',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string' },
          activity_type: { type: 'string', description: 'Type: family, adventure, cultural, beach, theme park', default: 'family' },
          num_results: { type: 'integer', default: 6 }
        },
        required: ['location']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_restaurants',
      description: 'Find family-friendly restaurants at a destination',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string' },
          cuisine: { type: 'string', description: 'Cuisine type (optional)', default: '' },
          family_friendly: { type: 'boolean', default: true }
        },
        required: ['location']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_travel_tips',
      description: 'Get practical travel tips, visa info, safety advice, and packing lists for families',
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string' },
          month: { type: 'string', description: 'Month of travel (optional)', default: '' }
        },
        required: ['destination']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_local_transport',
      description: 'Find local transportation options at the destination',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string' }
        },
        required: ['location']
      }
    }
  }
];

const TOOL_MAP = {
  web_search: (args) => toolWebSearch(args.query, args.max_results),
  get_weather: (args) => toolWeather(args.location, args.days),
  search_flights: (args) => toolFlights(args.origin, args.destination, args.departure_date, args.return_date, args.passengers),
  search_hotels: (args) => toolHotels(args.location, args.checkin, args.checkout, args.guests, args.rooms),
  destination_image: (args) => toolDestinationImage(args.location),
  currency_info: (args) => toolCurrency(args.from, args.to),
  find_activities: (args) => toolActivities(args.location, args.activity_type, args.num_results),
  find_restaurants: (args) => toolRestaurants(args.location, args.cuisine, args.family_friendly),
  get_travel_tips: (args) => toolTips(args.destination, args.month),
  find_local_transport: (args) => toolTransport(args.location)
};

// ─── Agent runner ─────────────────────────────────────────────────────────────

// Friendly "thinking" status text shown while a tool runs — gives the chat
// a ChatGPT-style narrated thought process instead of a generic spinner.
function toolStatusText(fnName, args) {
  args = args || {};
  switch (fnName) {
    case 'web_search':          return `Searching the web for "${args.query || 'more details'}"…`;
    case 'get_weather':         return `Checking the forecast for ${args.location || 'your destination'}…`;
    case 'search_flights':      return `Looking up flights from ${args.origin || '?'} to ${args.destination || '?'}…`;
    case 'search_hotels':       return `Finding hotels in ${args.location || 'your destination'}…`;
    case 'destination_image':   return `Generating a photo of ${args.location || 'your destination'}…`;
    case 'currency_info':       return `Checking the ${args.from_currency || '?'} → ${args.to_currency || '?'} exchange rate…`;
    case 'find_activities':     return `Finding things to do in ${args.location || 'your destination'}…`;
    case 'find_restaurants':    return `Looking for family-friendly restaurants in ${args.location || 'your destination'}…`;
    case 'get_travel_tips':     return `Gathering travel tips for ${args.destination || 'your destination'}…`;
    case 'find_local_transport':return `Checking local transport options in ${args.location || 'your destination'}…`;
    default:                    return `Working on it…`;
  }
}

async function runAgent(userMessage, history, apiKey, profile, emit) {
  const today = new Date().toISOString().split('T')[0];

  let profileContext = '';
  if (profile && profile.name && profile.name !== 'Guest') {
    const adults = profile.adults || 2;
    const children = profile.children || 0;
    const dietary = (profile.dietary || []).filter(d => d !== 'None').join(', ') || 'None';
    const style = profile.travel_style || '';
    const budget = profile.budget || '';
    const homeCity = profile.home_city || '';
    const childAges = profile.children_ages || '';

    profileContext = `\n\nUser profile:
- Name: ${profile.name}
- Home city: ${homeCity}
- Family: ${adults} adult(s), ${children} child(ren)${childAges ? ' (ages: ' + childAges + ')' : ''}
- Dietary requirements: ${dietary}
- Travel style: ${style}
- Budget: ${budget}

Personalise your recommendations based on this profile. Address the user by their first name.`;
  }

  const systemPrompt = `You are FamilyTripAI, an expert family travel planning assistant. You help families plan complete trips with practical, detailed advice tailored for travelling with children.

When planning a trip, always:
1. Generate a destination image first using destination_image
2. Search flights and hotels with direct booking links
3. Check the weather for the travel dates
4. Find top activities suitable for kids and adults
5. Recommend family-friendly restaurants (note any dietary requirements like kosher, halal, allergies)
6. Share practical travel tips including visa requirements, safety, and packing
7. Check currency exchange if travelling internationally
8. Build a clear day-by-day itinerary

Don't stop at the obvious basics — think through everything a trip like this actually requires, including the
logistics specific to its activities. For example:
- Safari trips: game-drive vehicle/4x4 hire or lodge transfers, ranger guides, park entry permits, vaccination & malaria advice
- Ski trips: lift passes, equipment & clothing rental, ski school for kids, transfers to/from the resort, altitude tips
- Beach/diving trips: gear rental, lessons/certification for kids, reef/marine park fees
- City breaks: transit passes, museum/attraction skip-the-line tickets, walking-tour bookings
Call out and (where a tool exists) look up these activity-specific bookings and costs alongside flights, hotels,
food and general activities, so the plan is genuinely complete and ready to act on — not just a checklist of basics.

Think carefully about children's needs: energy levels, meal times, rest breaks, age-appropriate activities, and safety.
Format responses with clear headers and sections. Be thorough and practical. Always finish with a written summary —
never end a turn after just running tools without giving the user your actual answer in words.
Today's date: ${today}${profileContext}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(history || []).slice(-4),
    { role: 'user', content: userMessage }
  ];

  const toolsUsed = [];
  const images = [];

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Tool results (especially web search) can be huge; trimming what we feed
  // back to the model keeps the per-request token count under the free-tier
  // TPM cap so multi-tool itineraries don't trip the rate limiter mid-run.
  const trimForContext = (s, max = 900) => {
    if (typeof s !== 'string') return s;
    return s.length > max ? s.slice(0, max) + '\n[...truncated for length]' : s;
  };

  const callGroq = async (msgs, useTools) => {
    const body = {
      model: CHAT_MODEL,
      messages: msgs,
      max_tokens: 1024
    };
    if (useTools) {
      body.tools = TOOLS_DEF;
      body.tool_choice = 'auto';
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });

      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { data = null; }

      if (resp.ok) return data;

      const code = data && data.error && data.error.code;

      // Rate limited: wait the suggested time (capped) and retry.
      if (resp.status === 429 && attempt < 2) {
        const match = /try again in ([\d.]+)s/i.exec(text);
        const waitMs = match ? Math.min(parseFloat(match[1]) * 1000 + 500, 20000) : 5000;
        await sleep(waitMs);
        continue;
      }

      const err = new Error(`Groq API error ${resp.status}: ${text}`);
      err.code = code;
      err.status = resp.status;
      throw err;
    }
  };

  // Reveal the final answer gradually (ChatGPT-style typewriter) by emitting
  // it in small word-chunks with short pauses, instead of dumping it all at once.
  const streamOutFinalAnswer = async (text) => {
    if (!emit || !text) return;
    const pieces = text.match(/\S+\s*|\s+/g) || [text];
    let buf = '';
    for (const piece of pieces) {
      buf += piece;
      if (buf.length >= 3) {
        await emit({ type: 'chunk', text: buf });
        buf = '';
        await sleep(16);
      }
    }
    if (buf) await emit({ type: 'chunk', text: buf });
  };

  // Groq sometimes finishes a tool-calling run with an empty (or whitespace-only)
  // assistant message — the agent "thinks" but never actually writes the answer.
  // When that happens, ask it explicitly to summarise its findings, and if that
  // still comes back empty, synthesise a friendly summary from the tools it ran
  // so the user is never left staring at a blank reply.
  const ensureFinalText = async (text) => {
    if (text && text.trim()) return text;
    try {
      const nudge = [...messages, { role: 'user', content: 'Now write your full final answer for the user — a clear, friendly, well-formatted summary of everything you found, with headers and sections as instructed. Do not call any more tools.' }];
      const followUp = await callGroq(nudge, false);
      const followUpMsg = followUp && followUp.choices && followUp.choices[0] && followUp.choices[0].message;
      const followUpText = followUpMsg && followUpMsg.content || '';
      if (followUpText.trim()) return followUpText;
    } catch (_) {}

    if (toolsUsed.length) {
      const seen = new Set();
      const lines = [];
      for (const t of toolsUsed) {
        if (seen.has(t.tool)) continue;
        seen.add(t.tool);
        lines.push('- ' + toolStatusText(t.tool, t.args).replace(/…$/, '.'));
      }
      return `Here's what I put together for you:\n\n${lines.join('\n')}\n\nTake a look at the results above — ask me to dig deeper into any part (flights, hotels, activities, tips) and I'll expand on it.`;
    }
    return "I wasn't able to put together a full answer that time — could you try asking again, maybe with a bit more detail about where and when you'd like to travel?";
  };

  for (let iter = 0; iter < 12; iter++) {
    let data;
    try {
      data = await callGroq(messages, true);
    } catch (e) {
      // The model occasionally emits malformed function-call syntax as plain text,
      // which Groq rejects as tool_use_failed. Retry once without tools so the
      // user still gets a useful plain-text answer instead of an error.
      if (e.code === 'tool_use_failed') {
        const fallback = await callGroq(messages, false);
        const fallbackMsg = fallback.choices[0].message;
        const text = await ensureFinalText(fallbackMsg.content || '');
        await streamOutFinalAnswer(text);
        return { response: text, tools_used: toolsUsed, images };
      }
      throw e;
    }

    const msg = data.choices[0].message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const text = await ensureFinalText(msg.content || '');
      await streamOutFinalAnswer(text);
      return { response: text, tools_used: toolsUsed, images };
    }

    // Append assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: msg.content || '',
      tool_calls: msg.tool_calls
    });

    // Execute each tool call, narrating what the agent is doing as it goes
    for (const tc of msg.tool_calls) {
      const fnName = tc.function.name;
      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch (_) {}

      toolsUsed.push({ tool: fnName, args });
      if (emit) await emit({ type: 'status', tool: fnName, text: toolStatusText(fnName, args) });

      let result = '';
      const fn = TOOL_MAP[fnName];
      if (fn) {
        try {
          result = await fn(args);
        } catch (e) {
          result = `Tool error: ${e.message}`;
        }
      } else {
        result = `Unknown tool: ${fnName}`;
      }

      // Extract destination images
      if (fnName === 'destination_image') {
        try {
          const parsed = JSON.parse(result);
          if (parsed.image_url && !images.includes(parsed.image_url)) {
            images.push(parsed.image_url);
            if (emit) await emit({ type: 'image', url: parsed.image_url });
          }
        } catch (_) {}
      }

      // Also scan all tool results for pollinations URLs
      const pollinationsMatches = (typeof result === 'string' ? result : '').match(/https:\/\/image\.pollinations\.ai\/prompt\/[^\s\)\]"']+/g);
      if (pollinationsMatches) {
        for (const u of pollinationsMatches) {
          if (!images.includes(u)) {
            images.push(u);
            if (emit) await emit({ type: 'image', url: u });
          }
        }
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: trimForContext(typeof result === 'string' ? result : JSON.stringify(result))
      });
    }
  }

  // Max iterations reached — return last assistant content if any
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
  const finalText = await ensureFinalText(lastAssistant ? lastAssistant.content : '');
  await streamOutFinalAnswer(finalText);
  return { response: finalText, tools_used: toolsUsed, images };
}

// ─── Structured search (Trips / Prices / For Me browsing) ────────────────────

async function runSearch(category, params, apiKey, profile) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const askForJSON = async (prompt) => {
    const body = {
      model: SEARCH_MODEL,
      messages: [
        { role: 'system', content: 'You are a travel data assistant. Reply with ONLY valid JSON matching the requested shape — no markdown fences, no commentary.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1280,
      response_format: { type: 'json_object' }
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { data = null; }
      if (resp.ok) return data;
      if (resp.status === 429 && attempt < 2) {
        const match = /try again in ([\d.]+)s/i.exec(text);
        const waitMs = match ? Math.min(parseFloat(match[1]) * 1000 + 500, 20000) : 5000;
        await sleep(waitMs);
        continue;
      }
      throw new Error(`Groq API error ${resp.status}: ${text}`);
    }
  };

  let familyNote = '';
  if (profile && profile.name && profile.name !== 'Guest') {
    familyNote = `Family: ${profile.adults || 2} adult(s), ${profile.children || 0} child(ren)` +
      `${profile.children_ages ? ' (ages ' + profile.children_ages + ')' : ''}. ` +
      `Travel style: ${profile.travel_style || 'balanced'}. Budget: ${profile.budget || 'moderate'}.`;
  }

  let prompt = '';
  let links = {};

  if (category === 'flights') {
    const { origin, destination, departure_date, return_date = '', passengers = 1 } = params;
    links = {
      'Google Flights': `https://www.google.com/travel/flights?q=flights+from+${encodeURIComponent(origin)}+to+${encodeURIComponent(destination)}+${departure_date}`,
      'Skyscanner': `https://www.skyscanner.com/transport/flights/${encodeURIComponent(String(origin).toLowerCase())}/${encodeURIComponent(String(destination).toLowerCase())}/${(departure_date || '').replace(/-/g, '')}`,
      'Kayak': `https://www.kayak.com/flights/${encodeURIComponent(origin)}-${encodeURIComponent(destination)}/${departure_date}${return_date ? '/' + return_date : ''}/${passengers}adults`
    };
    prompt = `Generate 6 realistic, varied example flight options from ${origin} to ${destination}, departing ${departure_date}${return_date ? ', returning ' + return_date : ''}, for ${passengers} passenger(s).
These are illustrative planning ESTIMATES (not live bookings) — vary airlines (use real airlines that plausibly fly this route), prices, durations, layover cities and stop counts realistically.
Write each "notes" field like a real flight-search result would: cabin class, baggage allowance, on-time rating, legroom, loyalty program, red-eye/overnight, etc. Only mention kids/family perks where genuinely relevant (e.g. a long-haul red-eye) — most notes should be general, not family-themed.${familyNote ? ' Context on the traveller: ' + familyNote : ''}
Reply with ONLY this JSON shape:
{"items": [{"airline": "string", "price_usd": number, "duration": "e.g. 9h 25m", "stops": number, "departure_time": "e.g. 08:40", "arrival_time": "e.g. 17:05", "notes": "short, varied, realistic note"}]}`;
  } else if (category === 'hotels') {
    const { location, checkin, checkout, guests = 2, rooms = 1 } = params;
    links = {
      'Booking.com': `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(location)}&checkin=${checkin}&checkout=${checkout}&group_adults=${guests}&no_rooms=${rooms}`,
      'Airbnb': `https://www.airbnb.com/s/${encodeURIComponent(location)}/homes?checkin=${checkin}&checkout=${checkout}&adults=${guests}`,
      'Hotels.com': `https://www.hotels.com/search.do?q-destination=${encodeURIComponent(location)}&q-check-in=${checkin}&q-check-out=${checkout}&q-rooms=${rooms}&q-room-0-adults=${guests}`
    };
    prompt = `Generate 6 realistic, varied example hotel options in ${location} for check-in ${checkin}, check-out ${checkout}, ${guests} guests, ${rooms} room(s).
These are illustrative planning ESTIMATES (not live bookings) — vary names, neighbourhoods, star ratings, prices and amenities realistically for this destination (mix of hotels, apart-hotels, resorts).
Pick amenities from a broad realistic mix (pool, gym, spa, free breakfast, parking, kitchenette, kids club, business centre, pet-friendly, beach access, etc.) — not every hotel needs to be family-themed.${familyNote ? ' Context on the traveller: ' + familyNote : ''}
Reply with ONLY this JSON shape:
{"items": [{"name": "string", "stars": number (1-5), "price_per_night_usd": number, "rating": number (1.0-5.0), "amenities": ["string", "string"], "notes": "short, varied, realistic note"}]}`;
  } else if (category === 'activities') {
    const { location, activity_type = 'family' } = params;
    prompt = `Generate 8 realistic, varied ${activity_type} activities and attractions in ${location}.
Mix well-known sights, museums, outdoor activities, tours, food experiences and local hidden gems — vary price, duration and audience (some great for kids, some more for adults, most for anyone). Don't force a "family" angle into every single one.${familyNote ? ' Context on the traveller: ' + familyNote : ''}
Reply with ONLY this JSON shape:
{"items": [{"name": "string", "category": "e.g. museum, park, beach, theme park, tour, food", "price_usd": number (per person; 0 if free), "duration": "e.g. 2-3 hours", "min_age": number (0 if no minimum), "rating": number (1.0-5.0), "notes": "short, varied, realistic note"}]}`;
  } else if (category === 'recommendations') {
    prompt = `Suggest 6 great family travel destinations tailored to this family. ${familyNote || 'No specific profile given — suggest broadly appealing family destinations.'}
For each, give a one-line reason it suits this family, the best season/months to visit, and a rough total trip budget estimate in USD for the whole family for one week.
Reply with ONLY this JSON shape:
{"items": [{"destination": "city, country", "why": "short reason tailored to the family", "best_time": "e.g. April-June", "est_budget_usd": number, "highlight": "one standout family activity there"}]}`;
  } else {
    throw new Error(`Unknown search category: ${category}`);
  }

  const data = await askForJSON(prompt);
  const content = (data && data.choices && data.choices[0].message.content) || '{}';
  let items = [];
  try {
    const parsed = JSON.parse(content);
    items = Array.isArray(parsed.items) ? parsed.items : [];
  } catch (_) {
    items = [];
  }

  return { category, items, links, params };
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>FamilyTripAI</title>
  <meta name="theme-color" content="#2b2924" />
  <meta name="description" content="AI family-travel planner — flights, hotels, weather, activities and a day-by-day itinerary in one chat." />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""><\/script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/globe.gl"><\/script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+SC:wght@400;500;600;700&family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    .hidden { display: none !important; }

    :root {
      --bg-dark:     #2b2924;
      --bg-panel:    #34322b;
      --bg-card:     #3d3a32;
      --border:      #4d473c;
      --border-light:#5c5547;
      --accent:      #c97b5f;
      --accent-dim:  #a8847a;
      --accent-glow: rgba(201,123,95,0.20);
      --teal:        #97a87f;
      --purple:      #9b89a6;
      --green:       #7d8c5c;
      --text-bright: #f7f1e6;
      --text-main:   #ddd2c4;
      --text-muted:  #a89c8d;
      --text-dim:    #756c60;
    }

    html, body { height: 100%; }

    body {
      font-family: 'Montserrat', system-ui, -apple-system, sans-serif;
      background: var(--bg-dark);
      color: var(--text-main);
      min-height: 100vh;
    }

    /* ── Page system ── */
    .page { display: none; }
    .page.active { display: flex; }

    /* ═══════════════════════════════════════════
       PAGE 1 — LOGIN  (cinematic editorial hero)
    ═══════════════════════════════════════════ */
    #page-login {
      min-height: 100vh;
      flex-direction: column;
      align-items: stretch;
      position: relative;
      background: #262420;
    }

    .hero-viewport {
      position: relative;
      min-height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
    }

    /* Full-bleed rotating photo slideshow */
    .hero-slideshow {
      position: absolute;
      inset: 0;
      z-index: 0;
      overflow: hidden;
    }

    .hero-slide {
      position: absolute;
      inset: 0;
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
      background-color: #2f2c27;
      background-image: linear-gradient(135deg, #4d473c, #2f2c27);
      opacity: 0;
      transition: opacity 2.5s ease-in-out, background-image 0.6s ease;
      transform: scale(1);
    }

    .hero-slide.active {
      opacity: 1;
      animation: kenBurns 22s ease-in-out infinite alternate;
    }

    @keyframes kenBurns {
      from { transform: scale(1); }
      to   { transform: scale(1.12); }
    }

    .hero-overlay {
      position: absolute;
      inset: 0;
      z-index: 1;
      background: linear-gradient(to top, rgba(38,36,32,0.88) 0%, rgba(38,36,32,0.48) 50%, rgba(38,36,32,0.15) 100%);
      pointer-events: none;
    }

    /* Editorial content block */
    .hero-content {
      position: relative;
      z-index: 2;
      width: 100%;
      max-width: 1180px;
      margin: 0 auto;
      padding: 0 40px 64px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 28px;
    }

    .hero-eyebrow {
      display: inline-block;
      font-family: 'Montserrat', system-ui, sans-serif;
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 3px;
      text-transform: uppercase;
      color: #d4a574;
      padding: 7px 14px;
      border: 1px solid rgba(212, 165, 116, 0.4);
      border-radius: 100px;
      background: rgba(13, 17, 23, 0.35);
    }

    .hero-headline {
      font-family: 'Cormorant Garamond', 'Cormorant SC', Georgia, serif;
      font-weight: 600;
      font-size: clamp(2.1rem, 5.4vw, 3.6rem);
      line-height: 1.12;
      letter-spacing: 0.2px;
      color: #faf9f7;
      max-width: 720px;
      text-shadow: 0 2px 24px rgba(0,0,0,0.35);
    }

    .hero-subtitle {
      font-family: 'Montserrat', system-ui, sans-serif;
      font-weight: 400;
      font-size: 1.02rem;
      line-height: 1.6;
      color: rgba(245, 243, 239, 0.78);
      max-width: 520px;
      letter-spacing: 0.1px;
    }

    /* Slide indicator dots */
    .hero-dots {
      display: flex;
      gap: 8px;
      margin-top: 4px;
    }

    .hero-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: rgba(245, 243, 239, 0.32);
      transition: background 0.4s ease, transform 0.4s ease;
    }

    .hero-dot.active {
      background: #d4a574;
      transform: scale(1.3);
    }

    /* ── Selling section (below the fold, before sign-in) ── */
    .sell-section {
      position: relative;
      z-index: 1;
      background: var(--bg-dark);
      padding: 72px 24px 88px;
      border-top: 1px solid var(--border);
    }

    .sell-inner {
      max-width: 1140px;
      margin: 0 auto;
    }

    .sell-eyebrow {
      display: inline-block;
      font-family: 'Montserrat', system-ui, sans-serif;
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 3px;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 14px;
    }

    .sell-title {
      font-family: 'Cormorant Garamond', 'Cormorant SC', Georgia, serif;
      font-weight: 600;
      font-size: clamp(1.8rem, 4vw, 2.6rem);
      color: var(--text-bright);
      margin-bottom: 12px;
      max-width: 640px;
    }

    .sell-sub {
      font-family: 'Montserrat', system-ui, sans-serif;
      color: var(--text-main);
      max-width: 620px;
      line-height: 1.65;
      margin-bottom: 44px;
    }

    .sell-features {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 40px;
    }

    .sell-feature {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 22px 20px;
    }

    .sell-feature h3 {
      font-family: 'Cormorant Garamond', 'Cormorant SC', Georgia, serif;
      font-size: 1.2rem;
      font-weight: 600;
      color: var(--accent);
      margin-bottom: 6px;
    }

    .sell-feature p {
      font-family: 'Montserrat', system-ui, sans-serif;
      font-size: 0.88rem;
      color: var(--text-muted);
      line-height: 1.55;
    }

    .sell-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 22px 24px;
      margin-bottom: 18px;
    }

    .sell-card-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }

    .sell-card-label {
      font-family: 'Montserrat', system-ui, sans-serif;
      font-size: 0.78rem;
      font-weight: 600;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--text-bright);
    }

    .sell-card-meta {
      font-family: 'Montserrat', system-ui, sans-serif;
      font-size: 0.74rem;
      color: var(--text-dim);
      font-style: italic;
    }

    .rate-row, .deal-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }

    .rate-chip {
      flex: 1 1 140px;
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .rate-pair {
      font-family: 'Montserrat', system-ui, sans-serif;
      font-size: 0.74rem;
      letter-spacing: 0.5px;
      color: var(--text-muted);
    }

    .rate-val {
      font-family: 'Cormorant Garamond', 'Cormorant SC', Georgia, serif;
      font-size: 1.5rem;
      font-weight: 600;
      color: var(--text-bright);
    }

    .deal-card {
      flex: 1 1 220px;
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 18px;
      transition: border-color 0.4s ease, transform 0.4s ease;
    }

    .deal-card.refreshing { opacity: 0; transform: translateY(6px); }

    .deal-city {
      font-family: 'Cormorant Garamond', 'Cormorant SC', Georgia, serif;
      font-size: 1.2rem;
      font-weight: 600;
      color: var(--text-bright);
      margin-bottom: 4px;
    }

    .deal-range {
      font-family: 'Montserrat', system-ui, sans-serif;
      font-size: 1rem;
      font-weight: 600;
      color: var(--accent);
      margin-bottom: 2px;
    }

    .deal-note {
      font-family: 'Montserrat', system-ui, sans-serif;
      font-size: 0.76rem;
      color: var(--text-muted);
    }

    .login-card {
      position: relative;
      z-index: 2;
      background: rgba(38, 36, 32, 0.6);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(245, 243, 239, 0.12);
      border-radius: 16px;
      padding: 30px 28px 26px;
      width: 100%;
      max-width: 400px;
      margin-top: 8px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
    }

    .login-brand {
      margin-bottom: 4px;
    }

    .login-brand h1 {
      font-family: 'Cormorant Garamond', 'Cormorant SC', Georgia, serif;
      font-size: 1.5rem;
      font-weight: 600;
      letter-spacing: 0.3px;
      color: #faf9f7;
    }

    .login-brand p {
      font-family: 'Montserrat', system-ui, sans-serif;
      color: rgba(245, 243, 239, 0.6);
      font-size: 0.82rem;
      margin-top: 4px;
      letter-spacing: 0.2px;
    }

    /* Auth buttons */
    .auth-btn {
      width: 100%;
      padding: 13px 20px;
      border-radius: 10px;
      font-size: 0.88rem;
      font-family: 'Montserrat', system-ui, sans-serif;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      transition: transform 0.15s, box-shadow 0.15s;
      border: none;
      margin-bottom: 10px;
    }

    .auth-btn:hover { transform: translateY(-1px); box-shadow: 0 10px 28px rgba(0,0,0,0.28); }
    .auth-btn:active { transform: translateY(0); }

    .btn-google { background: #faf9f7; color: #1f2937; border: 1px solid rgba(0,0,0,0.08); box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
    .btn-apple  { background: #332f29; color: #faf9f7; border: 1px solid rgba(245,243,239,0.14); }

    .auth-sep {
      text-align: center;
      color: rgba(245, 243, 239, 0.4);
      font-family: 'Montserrat', system-ui, sans-serif;
      font-size: 0.78rem;
      margin: 14px 0;
      position: relative;
    }

    .auth-sep::before, .auth-sep::after {
      content: '';
      position: absolute;
      top: 50%;
      width: 42%;
      height: 1px;
      background: rgba(245, 243, 239, 0.14);
    }
    .auth-sep::before { left: 0; }
    .auth-sep::after  { right: 0; }

    .guest-link {
      display: block;
      text-align: center;
      font-family: 'Montserrat', system-ui, sans-serif;
      color: rgba(245, 243, 239, 0.55);
      font-size: 0.8rem;
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 3px;
      transition: color 0.15s;
    }
    .guest-link:hover { color: #faf9f7; }

    .guest-cta {
      display: block;
      width: 100%;
      text-align: center;
      font-family: 'Montserrat', system-ui, sans-serif;
      font-weight: 600;
      font-size: 0.92rem;
      color: var(--text-bright, #f7f1e6);
      background: rgba(245, 243, 239, 0.08);
      border: 1px solid rgba(245, 243, 239, 0.22);
      border-radius: 10px;
      padding: 12px 16px;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
      margin-bottom: 6px;
    }
    .guest-cta:hover { background: rgba(245, 243, 239, 0.16); border-color: rgba(245, 243, 239, 0.4); }
    .guest-cta-note {
      text-align: center;
      font-family: 'Montserrat', system-ui, sans-serif;
      font-size: 0.74rem;
      color: rgba(245, 243, 239, 0.45);
      margin: 6px 0 14px;
    }

    /* ═══════════════════════════════════════════
       PAGE 2 — PROFILE
    ═══════════════════════════════════════════ */
    #page-profile {
      min-height: 100vh;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      padding: 40px 16px 60px;
      background: linear-gradient(180deg, #332f29 0%, #262420 100%);
      overflow-y: auto;
    }

    .profile-card {
      background: rgba(38, 36, 32, 0.7);
      border: 1px solid rgba(245, 243, 239, 0.1);
      border-radius: 16px;
      padding: 40px 36px;
      width: 100%;
      max-width: 520px;
      box-shadow: 0 24px 80px rgba(0,0,0,0.5);
    }

    .profile-header {
      text-align: center;
      margin-bottom: 32px;
    }

    .profile-header h2 {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text-bright);
      letter-spacing: -0.5px;
    }

    .profile-header p {
      color: var(--text-muted);
      font-size: 0.82rem;
      margin-top: 5px;
    }

    /* Form fields */
    .field-group {
      margin-bottom: 20px;
    }

    .field-label {
      font-size: 0.78rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      display: block;
    }

    .field-input {
      width: 100%;
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 11px 14px;
      color: var(--text-bright);
      font-size: 0.88rem;
      outline: none;
      transition: border-color 0.15s, background 0.15s;
      font-family: inherit;
    }
    .field-input:focus { border-color: var(--accent); background: rgba(201,123,95,0.06); }
    .field-input::placeholder { color: var(--text-dim); }

    /* Stepper */
    .stepper {
      display: flex;
      align-items: center;
      gap: 0;
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      width: fit-content;
    }

    .stepper-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 1.1rem;
      width: 40px;
      height: 40px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .stepper-btn:hover { background: rgba(255,255,255,0.08); color: var(--text-bright); }

    .stepper-val {
      width: 48px;
      text-align: center;
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--text-bright);
      border-left: 1px solid var(--border);
      border-right: 1px solid var(--border);
      padding: 0 4px;
      line-height: 40px;
    }

    /* Chips */
    .chip-group {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .chip {
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 0.78rem;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid var(--border);
      color: var(--text-muted);
      background: rgba(255,255,255,0.04);
      transition: all 0.15s;
      user-select: none;
    }
    .chip:hover { border-color: var(--border-light); color: var(--text-main); }
    .chip.selected {
      background: rgba(201,123,95,0.18);
      border-color: var(--accent);
      color: #93c5fd;
    }

    /* Style cards */
    .style-cards {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }

    .style-card {
      padding: 14px 12px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.04);
      cursor: pointer;
      text-align: center;
      transition: all 0.15s;
    }
    .style-card:hover { border-color: var(--border-light); background: rgba(255,255,255,0.07); }
    .style-card.selected { border-color: var(--accent); background: rgba(201,123,95,0.14); }

    .style-card .sc-icon {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      margin: 0 auto 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.1rem;
    }

    .style-card .sc-label {
      font-size: 0.78rem;
      font-weight: 600;
      color: var(--text-main);
    }

    .style-card .sc-desc {
      font-size: 0.7rem;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .btn-start {
      width: 100%;
      padding: 14px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--accent), var(--purple));
      color: #fff;
      font-size: 0.95rem;
      font-weight: 700;
      border: none;
      cursor: pointer;
      margin-top: 28px;
      transition: opacity 0.15s, transform 0.15s;
      letter-spacing: 0.2px;
    }
    .btn-start:hover { opacity: 0.92; transform: translateY(-1px); }
    .btn-start:active { transform: translateY(0); }

    /* ═══════════════════════════════════════════
       PAGE 3 — CHAT APP
    ═══════════════════════════════════════════ */
    #page-app {
      flex-direction: column;
      min-height: 100vh;
      background: var(--bg-dark);
    }

    /* App header */
    .app-header {
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border);
      padding: 13px 24px;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }

    .app-brand {
      font-family: 'Cormorant Garamond', 'Cormorant SC', Georgia, serif;
      font-size: 1.05rem;
      font-weight: 600;
      letter-spacing: 0.2px;
      color: #faf9f7;
    }

    .app-header-right {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .user-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--accent), var(--purple));
      color: #fff;
      font-size: 0.75rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .user-name {
      font-size: 0.82rem;
      color: var(--text-muted);
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .key-pill {
      font-size: 0.7rem;
      padding: 4px 10px;
      border-radius: 20px;
      border: 1px solid var(--border);
      color: var(--text-dim);
    }
    .key-pill.active { border-color: #065f46; color: var(--green); background: rgba(16,185,129,0.1); }
    .key-pill.missing { border-color: #7f1d1d; color: #f87171; background: rgba(248,113,113,0.1); }

    .settings-btn {
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 7px;
      color: var(--text-muted);
      width: 32px;
      height: 32px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, color 0.15s;
    }
    .settings-btn:hover { background: rgba(255,255,255,0.06); color: var(--text-main); }

    /* Persistent nav bar */
    .app-nav {
      display: flex;
      gap: 4px;
      margin-left: 28px;
    }
    .nav-tab {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 0.85rem;
      font-weight: 500;
      font-family: 'Montserrat', system-ui, sans-serif;
      padding: 7px 15px;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .nav-tab:hover { background: rgba(255,255,255,0.05); color: var(--text-main); }
    .nav-tab.active { background: rgba(201,123,95,0.14); color: var(--text-bright); }

    .tab-panel { display: none; flex: 1; min-height: 0; flex-direction: column; overflow: hidden; }
    .tab-panel.active { display: flex; }

    /* Browse pages (Trips / Prices / For Me) */
    .browse-wrap {
      flex: 1;
      overflow-y: auto;
      padding: 28px 24px 60px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .browse-inner { width: 100%; max-width: 980px; }

    .browse-heading h2 {
      font-family: 'Cormorant Garamond', 'Cormorant SC', Georgia, serif;
      font-size: 1.5rem;
      font-weight: 600;
      color: var(--text-bright);
      letter-spacing: -0.3px;
    }
    .browse-heading p { color: var(--text-muted); font-size: 0.86rem; margin-top: 4px; }

    /* ── Explore globe ── */
    .globe-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 18px;
      margin: 18px 0 6px;
      font-family: 'Montserrat', system-ui, sans-serif;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .globe-legend span { display: flex; align-items: center; gap: 7px; }
    .globe-legend i {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .globe-viz {
      width: 100%;
      height: 460px;
      margin-top: 14px;
      border-radius: 16px;
      overflow: hidden;
      background: radial-gradient(circle at 50% 40%, #34322b 0%, #2b2924 70%);
      border: 1px solid var(--border);
    }
    .globe-viz canvas { border-radius: 16px; }

    .subnav { display: flex; gap: 8px; margin: 18px 0 16px; }
    .subnav-btn {
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 0.82rem;
      font-weight: 500;
      padding: 7px 16px;
      border-radius: 20px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .subnav-btn:hover { color: var(--text-main); }
    .subnav-btn.active { background: rgba(201,123,95,0.14); border-color: var(--accent-dim); color: var(--text-bright); }

    .search-form {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px;
      margin-bottom: 18px;
    }
    .search-form.hidden { display: none; }
    .search-form input, .search-form select {
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-bright);
      font-size: 0.84rem;
      font-family: 'Montserrat', system-ui, sans-serif;
      padding: 9px 12px;
      flex: 1 1 160px;
      min-width: 0;
    }
    .search-form input:focus, .search-form select:focus { outline: none; border-color: var(--accent); }
    .search-form input::placeholder { color: var(--text-dim); }
    .search-form button {
      flex: 0 0 auto;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 0.84rem;
      font-weight: 600;
      font-family: 'Montserrat', system-ui, sans-serif;
      padding: 9px 22px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .search-form button:hover { background: var(--accent-dim); }
    .search-form button:disabled { opacity: 0.6; cursor: default; }

    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 18px;
      align-items: center;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px 16px;
      margin-bottom: 18px;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .filter-bar.hidden { display: none; }
    .filter-bar label { display: flex; align-items: center; gap: 7px; }
    .filter-bar select {
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-bright);
      font-size: 0.78rem;
      padding: 5px 9px;
      font-family: 'Montserrat', system-ui, sans-serif;
    }
    .filter-bar input[type="range"] { accent-color: var(--accent); }

    .estimate-note {
      font-size: 0.76rem;
      color: var(--text-dim);
      margin: -8px 0 12px;
      font-style: italic;
    }
    /* Itinerary export controls shown under a completed plan */
    .export-bar {
      display: flex; flex-wrap: wrap; gap: 8px;
      margin-top: 14px; padding-top: 12px;
      border-top: 1px solid var(--border);
    }
    .export-btn {
      font-family: inherit; font-size: 0.78rem; cursor: pointer;
      color: var(--text-main); background: transparent;
      border: 1px solid var(--border); border-radius: 20px;
      padding: 6px 14px; transition: border-color 0.15s, background 0.15s, color 0.15s;
    }
    .export-btn:hover { border-color: var(--accent); color: var(--text-bright); background: rgba(201,123,95,0.08); }
    .export-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .detail-map { height: 220px; width: 100%; border-radius: 12px; margin-top: 10px; overflow: hidden; background: var(--bg-dark); }
    .detail-map .leaflet-control-attribution { font-size: 9px; }

    .booking-links { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
    .booking-links a {
      font-size: 0.78rem;
      color: var(--accent);
      text-decoration: none;
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 6px 14px;
      transition: border-color 0.15s, background 0.15s;
    }
    .booking-links a:hover { border-color: var(--accent-dim); background: rgba(201,123,95,0.08); }

    .result-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 14px;
    }
    .result-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px 18px;
      display: flex;
      flex-direction: column;
      gap: 7px;
      cursor: pointer;
      transition: border-color 0.15s, transform 0.15s, background 0.15s;
    }
    .result-card:hover {
      border-color: var(--accent-dim, #a8847a);
      background: var(--bg-panel);
      transform: translateY(-2px);
    }
    .result-card .rc-tap-hint {
      font-size: 0.72rem;
      color: var(--text-dim);
      letter-spacing: 0.3px;
    }
    .result-card .rc-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
    .result-card .rc-title { font-weight: 600; color: var(--text-bright); font-size: 0.94rem; line-height: 1.3; }
    .result-card .rc-price { font-weight: 700; color: var(--green); font-size: 1.02rem; white-space: nowrap; }
    .result-card .rc-meta { font-size: 0.78rem; color: var(--text-muted); display: flex; flex-wrap: wrap; gap: 6px 12px; }
    .result-card .rc-tags { display: flex; flex-wrap: wrap; gap: 6px; }
    .result-card .rc-tag {
      font-size: 0.7rem;
      color: var(--text-muted);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2px 9px;
    }
    .result-card .rc-note { font-size: 0.8rem; color: var(--text-main); line-height: 1.45; }

    .browse-empty, .browse-loading, .browse-error {
      text-align: center;
      color: var(--text-muted);
      font-size: 0.86rem;
      padding: 40px 20px;
    }
    .browse-error { color: #f87171; }

    .reco-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .reco-card img { width: 100%; height: 150px; object-fit: cover; display: block; }
    .reco-card .reco-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 7px; }
    .reco-card .reco-dest { font-family: 'Cormorant Garamond', 'Cormorant SC', Georgia, serif; font-size: 1.08rem; font-weight: 600; color: var(--text-bright); }
    .reco-card .reco-why { font-size: 0.82rem; color: var(--text-main); line-height: 1.45; }
    .reco-card .reco-meta { font-size: 0.76rem; color: var(--text-muted); display: flex; flex-wrap: wrap; gap: 6px 14px; }
    .reco-card .reco-plan {
      align-self: flex-start;
      margin-top: 4px;
      background: transparent;
      border: 1px solid var(--accent-dim);
      color: var(--accent);
      font-size: 0.78rem;
      font-weight: 600;
      font-family: 'Montserrat', system-ui, sans-serif;
      border-radius: 18px;
      padding: 6px 16px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .reco-card .reco-plan:hover { background: rgba(201,123,95,0.1); }

    .price-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-bottom: 18px;
    }
    .price-tool-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px 18px;
      flex: 1 1 260px;
    }
    .price-tool-card h3 { font-size: 0.9rem; color: var(--text-bright); font-weight: 600; margin-bottom: 10px; }
    .price-tool-card .pt-row { display: flex; gap: 8px; }
    .price-tool-card input, .price-tool-card select {
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 7px;
      color: var(--text-bright);
      font-size: 0.8rem;
      font-family: 'Montserrat', system-ui, sans-serif;
      padding: 8px 10px;
      flex: 1;
      min-width: 0;
    }
    .price-tool-card button {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 7px;
      font-size: 0.8rem;
      font-weight: 600;
      font-family: 'Montserrat', system-ui, sans-serif;
      padding: 8px 16px;
      cursor: pointer;
    }
    .price-tool-card button:hover { background: var(--accent-dim); }
    .budget-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin-bottom: 12px; }
    .budget-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 0.78rem; color: var(--text-muted); }
    .budget-grid input, .budget-grid select {
      font-family: inherit; font-size: 0.85rem; color: var(--text-main);
      background: var(--bg-dark); border: 1px solid var(--border);
      border-radius: 8px; padding: 7px 9px; width: 100%;
    }
    .price-tool-result { margin-top: 12px; font-size: 0.84rem; color: var(--text-main); line-height: 1.6; }
    .price-tool-result .pt-rate { color: var(--green); font-weight: 700; }

    /* ── Dashboard ── */
    .dash-wrap {
      flex: 1;
      overflow-y: auto;
      padding: 28px 24px 60px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .dash-inner { width: 100%; max-width: 1080px; }
    .dash-greeting h2 {
      font-family: 'Cormorant Garamond', 'Cormorant SC', Georgia, serif;
      font-size: 1.6rem;
      color: var(--text-bright);
      margin-bottom: 4px;
    }
    .dash-greeting p { color: var(--text-muted); font-size: 0.92rem; margin-bottom: 22px; }

    .dash-section-label {
      font-family: 'Montserrat', system-ui, sans-serif;
      font-size: 0.74rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent);
      font-weight: 700;
      margin: 26px 0 12px;
    }
    .dash-section-label:first-child { margin-top: 0; }

    .dash-quick-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .dash-quick-card {
      flex: 1 1 200px;
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 18px;
      cursor: pointer;
      transition: border-color 0.2s ease, transform 0.2s ease;
    }
    .dash-quick-card:hover { border-color: var(--accent); transform: translateY(-2px); }
    .dash-quick-card h3 {
      font-family: 'Cormorant Garamond', 'Cormorant SC', Georgia, serif;
      font-size: 1.1rem;
      color: var(--text-bright);
      margin-bottom: 4px;
    }
    .dash-quick-card p { font-size: 0.8rem; color: var(--text-muted); }

    .dash-photo-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 14px;
    }
    .dash-photo-card {
      position: relative;
      height: 200px;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid var(--border);
      cursor: pointer;
      background: linear-gradient(135deg, var(--bg-panel), var(--bg-card));
      background-size: cover;
      background-position: center;
      transition: transform 0.3s ease, border-color 0.3s ease;
    }
    .dash-photo-card:hover { transform: translateY(-3px) scale(1.01); border-color: var(--accent); }
    .dash-photo-overlay {
      position: absolute;
      inset: auto 0 0 0;
      padding: 14px 16px;
      background: linear-gradient(to top, rgba(20, 18, 16, 0.92), rgba(20, 18, 16, 0));
    }
    .dash-photo-overlay h3 {
      font-family: 'Cormorant Garamond', 'Cormorant SC', Georgia, serif;
      font-size: 1.2rem;
      color: #fff;
      margin-bottom: 2px;
    }
    .dash-photo-overlay p { font-size: 0.76rem; color: rgba(255,255,255,0.82); }
    .dash-photo-overlay span.dpc-cta {
      display: inline-block;
      margin-top: 6px;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: var(--accent);
    }

    /* Chat body */
    .chat-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      overflow: hidden;
    }

    #messages {
      width: 100%;
      max-width: 820px;
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 24px 20px 16px;
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }

    /* Welcome screen */
    .welcome {
      text-align: center;
      padding: 50px 20px 40px;
      max-width: 540px;
      margin: 0 auto;
    }

    .welcome-logo {
      width: 64px;
      height: 64px;
      border-radius: 16px;
      background: linear-gradient(135deg, var(--accent), var(--purple));
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .welcome h2 {
      font-size: 1.45rem;
      font-weight: 700;
      color: var(--text-bright);
      letter-spacing: -0.5px;
      margin-bottom: 10px;
    }

    .welcome p {
      color: var(--text-muted);
      font-size: 0.85rem;
      line-height: 1.65;
      margin-bottom: 18px;
    }

    .profile-chips {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 6px;
      margin-top: 14px;
    }

    .profile-chip {
      background: rgba(201,123,95,0.12);
      border: 1px solid rgba(201,123,95,0.25);
      color: #93c5fd;
      border-radius: 20px;
      padding: 4px 12px;
      font-size: 0.72rem;
      font-weight: 500;
    }

    /* Messages */
    .msg {
      display: flex;
      gap: 10px;
      animation: msgIn 0.22s ease;
    }

    @keyframes msgIn {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .msg.user { flex-direction: row-reverse; }

    .msg-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      font-size: 0.7rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      align-self: flex-start;
      margin-top: 2px;
    }

    .msg.user .msg-avatar { background: linear-gradient(135deg, var(--accent), var(--accent-dim)); color: #fff; }
    .msg.bot  .msg-avatar { background: linear-gradient(135deg, #97a87f, #7d8c5c); color: #fff; }

    .bubble {
      max-width: 82%;
      padding: 12px 16px;
      border-radius: 14px;
      font-size: 0.875rem;
      line-height: 1.65;
    }

    .msg.user .bubble {
      background: linear-gradient(135deg, var(--accent), var(--accent-dim));
      color: #fff;
      border-bottom-right-radius: 4px;
    }

    .msg.bot .bubble {
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-main);
      border-bottom-left-radius: 4px;
    }

    .bubble h1, .bubble h2, .bubble h3 {
      color: #93c5fd;
      margin: 14px 0 6px;
      font-size: 0.95em;
    }
    .bubble h1 { font-size: 1.05em; }
    .bubble p  { margin: 5px 0; }
    .bubble ul, .bubble ol { padding-left: 20px; margin: 6px 0; }
    .bubble li { margin: 3px 0; }
    .bubble strong { color: #93c5fd; }
    .bubble a  { color: #c97b5f; text-decoration: none; }
    .bubble a:hover { text-decoration: underline; }
    .bubble code { background: var(--bg-dark); padding: 2px 5px; border-radius: 3px; font-size: 0.85em; }
    .bubble hr { border-color: var(--border); margin: 10px 0; }
    .bubble table { border-collapse: collapse; width: 100%; font-size: 0.82em; margin: 8px 0; }
    .bubble th, .bubble td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
    .bubble th { background: var(--bg-dark); color: #93c5fd; }

    .dest-img {
      width: 100%;
      max-height: 220px;
      object-fit: cover;
      border-radius: 10px;
      margin-bottom: 14px;
      display: block;
      border: 1px solid var(--border);
    }

    /* Shown in place of an AI-generated photo if it fails to load */
    .img-fallback {
      width: 100%;
      min-height: 140px;
      max-height: 220px;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 16px;
      background: linear-gradient(135deg, var(--accent-glow), var(--bg-card));
      border: 1px solid var(--border);
      border-radius: 10px;
      font-family: 'Cormorant Garamond', 'Cormorant SC', Georgia, serif;
      font-size: 1.05rem;
      font-weight: 600;
      color: var(--text-bright);
    }

    .tools-row {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
    }

    .tool-tag {
      background: var(--bg-dark);
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 12px;
      padding: 2px 9px;
      font-size: 0.68rem;
    }

    /* ChatGPT-style narrated "thought process" while the agent works */
    .thinking-steps {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 4px;
    }

    .thinking-steps.collapsed {
      opacity: 0.55;
    }

    .thought-step {
      display: flex;
      align-items: center;
      gap: 9px;
      font-family: 'Montserrat', system-ui, sans-serif;
      font-size: 0.82rem;
      color: var(--text-muted);
      animation: thoughtIn 0.35s ease;
    }

    .thought-step.done .thought-text { color: var(--text-dim); }
    .thought-step.done .thought-dot { background: var(--text-dim); animation: none; }

    .thought-step.active .thought-text { color: var(--text-main); }

    .thought-dot {
      flex-shrink: 0;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent);
      animation: dotPulse 1.3s infinite;
    }

    @keyframes thoughtIn {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    @keyframes dotPulse {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.45; }
      40%            { transform: scale(1);   opacity: 1; }
    }

    /* Blinking caret shown at the end of text while it's still streaming in */
    .caret {
      display: inline-block;
      width: 2px;
      height: 1em;
      margin-left: 2px;
      vertical-align: text-bottom;
      background: var(--accent);
      animation: caretBlink 0.9s steps(1) infinite;
    }

    @keyframes caretBlink {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0; }
    }

    /* Input area */
    .input-area {
      width: 100%;
      max-width: 820px;
      padding: 8px 20px 22px;
    }

    .suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      margin-bottom: 10px;
    }

    .suggestion {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 5px 13px;
      font-size: 0.74rem;
      color: var(--text-muted);
      cursor: pointer;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
    }
    .suggestion:hover { border-color: var(--accent); color: var(--text-main); background: rgba(201,123,95,0.08); }

    .input-row {
      display: flex;
      gap: 8px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 12px;
      align-items: flex-end;
      transition: border-color 0.15s;
    }
    .input-row:focus-within { border-color: var(--accent); }

    #user-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--text-bright);
      font-size: 0.88rem;
      resize: none;
      max-height: 140px;
      line-height: 1.55;
      font-family: inherit;
    }
    #user-input::placeholder { color: var(--text-dim); }

    #send-btn {
      background: linear-gradient(135deg, var(--accent), var(--accent-dim));
      border: none;
      border-radius: 8px;
      width: 38px;
      height: 38px;
      cursor: pointer;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: opacity 0.15s, transform 0.15s;
    }
    #send-btn:hover:not(:disabled) { opacity: 0.9; transform: translateY(-1px); }
    #send-btn:disabled { opacity: 0.3; cursor: not-allowed; transform: none; }

    /* Settings modal */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.75);
      z-index: 200;
      align-items: center;
      justify-content: center;
    }
    .modal-overlay.open { display: flex; }

    .modal {
      background: var(--bg-panel);
      border: 1px solid var(--border-light);
      border-radius: 14px;
      padding: 28px;
      width: 100%;
      max-width: 460px;
      margin: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6);
    }

    .modal h2 { font-size: 1rem; font-weight: 700; color: var(--text-bright); margin-bottom: 6px; }
    .modal p  { font-size: 0.82rem; color: var(--text-muted); margin-bottom: 16px; line-height: 1.55; }
    .modal a  { color: #c97b5f; }

    .modal-input {
      width: 100%;
      background: var(--bg-dark);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 11px 13px;
      color: var(--text-bright);
      font-size: 0.87rem;
      font-family: monospace;
      outline: none;
      transition: border-color 0.15s;
    }
    .modal-input:focus { border-color: var(--accent); }

    .modal-actions {
      display: flex;
      gap: 8px;
      margin-top: 14px;
      justify-content: flex-end;
    }

    /* ── Result detail popup (flights / hotels / activities) ── */
    .modal.detail-modal { max-width: 560px; }
    .detail-head {
      display: flex; justify-content: space-between; align-items: flex-start; gap: 14px;
      margin-bottom: 4px;
    }
    .detail-head h2 { font-size: 1.18rem; margin-bottom: 2px; }
    .detail-price { font-weight: 700; color: var(--green); font-size: 1.1rem; white-space: nowrap; }
    .detail-meta {
      display: flex; flex-wrap: wrap; gap: 7px 14px;
      font-size: 0.82rem; color: var(--text-muted); margin-bottom: 10px;
    }
    .detail-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .detail-note {
      font-size: 0.88rem; color: var(--text-main); line-height: 1.6;
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 10px; padding: 12px 14px; margin-bottom: 16px;
    }
    .detail-disclaimer {
      font-size: 0.74rem; color: var(--text-dim); margin-bottom: 14px; line-height: 1.5;
    }
    .detail-section-label {
      font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.6px;
      color: var(--text-dim); margin-bottom: 8px; font-weight: 600;
    }
    .detail-links { display: flex; flex-direction: column; gap: 8px; margin-bottom: 6px; }
    .detail-link {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px;
      padding: 11px 14px; text-decoration: none; color: var(--text-bright);
      font-size: 0.86rem; font-weight: 600; transition: border-color 0.15s, background 0.15s;
    }
    .detail-link:hover { border-color: var(--accent); background: var(--bg-panel); }
    .detail-link span.dl-sub { font-weight: 400; color: var(--text-muted); font-size: 0.76rem; }
    .detail-link .dl-arrow { color: var(--accent); font-size: 1rem; }

    .mbtn {
      padding: 8px 18px;
      border-radius: 7px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: opacity 0.15s;
    }
    .mbtn:hover { opacity: 0.85; }
    .mbtn-primary { background: var(--accent); color: #fff; }
    .mbtn-secondary { background: rgba(255,255,255,0.06); color: var(--text-main); border-color: var(--border); }
    .mbtn-danger { background: transparent; color: #f87171; border-color: #7f1d1d; margin-right: auto; }

    /* Error toast */
    .toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(80px);
      background: #7f1d1d;
      color: #fca5a5;
      border: 1px solid #b91c1c;
      border-radius: 8px;
      padding: 10px 20px;
      font-size: 0.82rem;
      z-index: 300;
      transition: transform 0.3s ease;
      white-space: nowrap;
      max-width: 90vw;
    }
    .toast.show { transform: translateX(-50%) translateY(0); }

    @media (max-width: 600px) {
      .login-card, .profile-card { padding: 32px 20px 28px; }
      .style-cards { grid-template-columns: 1fr 1fr; }
      .bubble { max-width: 92%; }
      .app-header { padding: 11px 16px; }
      .hero-content { padding: 0 20px 40px; gap: 18px; }
      .hero-headline { max-width: 100%; }
      .hero-subtitle { max-width: 100%; }
      .app-nav { margin-left: 10px; gap: 2px; }
      .nav-tab { padding: 6px 10px; font-size: 0.78rem; }
      .user-name { display: none; }
      .browse-wrap { padding: 18px 14px 50px; }
      .search-form { padding: 14px; }
      .price-tools { flex-direction: column; }
    }
  </style>
</head>
<body>

<!-- Populated by JS with real airports — gives the flight search a proper
     dropdown of "City (CODE) — Airport name" so users don't have to guess
     the exact spelling our search expects. -->
<datalist id="airport-list"></datalist>

<!-- ═══ PAGE 1: LOGIN ═══════════════════════════════════════════════════════ -->
<div id="page-login" class="page active">
  <div class="hero-viewport">
    <div class="hero-slideshow" id="hero-slideshow"></div>
    <div class="hero-overlay"></div>

    <div class="hero-content">
      <span class="hero-eyebrow">AI-Powered Travel Planning</span>
      <h1 class="hero-headline">Unforgettable family journeys, planned by AI</h1>
      <p class="hero-subtitle">From the Great Wall to the canals of Venice — get personalised, day-by-day itineraries crafted around your family's pace, ages and tastes.</p>
      <div class="hero-dots" id="hero-dots"></div>

      <div class="login-card">
        <div class="login-brand">
          <h1>FamilyTripAI</h1>
          <p>The smartest way to plan family travel</p>
        </div>

        <button class="guest-cta" onclick="guestContinue()">Skip sign-in &mdash; start planning now</button>
        <p class="guest-cta-note">No account needed. Add your free Groq API key in Settings whenever you're ready — the app works instantly without Google or Apple.</p>

        <div class="auth-sep">or sign in</div>

        <button class="auth-btn btn-google" onclick="beginSignup('google')">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/><\/svg>
          Continue with Google
        </button>

        <button class="auth-btn btn-apple" onclick="beginSignup('apple')">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/><\/svg>
          Continue with Apple
        </button>
      </div>
    </div>
  </div>

  <!-- ── Selling section: features + live data teasers, refreshes every 20s ── -->
  <section class="sell-section">
    <div class="sell-inner">
      <span class="sell-eyebrow">Why families choose FamilyTripAI</span>
      <h2 class="sell-title">Everything you need to plan a trip, in one place — and it's free</h2>
      <p class="sell-sub">AI-built day-by-day itineraries, real-time currency rates, and direct links to live fares on the booking sites you already trust. No spreadsheets, no guesswork — just a plan your whole family will enjoy.</p>

      <div class="sell-features">
        <div class="sell-feature">
          <h3>AI-crafted itineraries</h3>
          <p>Day-by-day plans tuned to your kids' ages, energy levels, dietary needs and your budget — built in seconds.</p>
        </div>
        <div class="sell-feature">
          <h3>Live currency rates</h3>
          <p>Real exchange rates pulled live and refreshed automatically, so you always know what your trip really costs.</p>
        </div>
        <div class="sell-feature">
          <h3>Direct booking links</h3>
          <p>Jump straight to Google Flights, Skyscanner, Booking.com and Airbnb to lock in real, live fares.</p>
        </div>
      </div>

      <div class="sell-card">
        <div class="sell-card-head">
          <span class="sell-card-label">Live exchange rates</span>
          <span class="sell-card-meta" id="sell-rates-meta">Updating…</span>
        </div>
        <div class="rate-row" id="sell-rates-row">
          <div class="rate-chip"><span class="rate-pair">USD → EUR</span><span class="rate-val">—</span></div>
          <div class="rate-chip"><span class="rate-pair">USD → GBP</span><span class="rate-val">—</span></div>
          <div class="rate-chip"><span class="rate-pair">USD → JPY</span><span class="rate-val">—</span></div>
          <div class="rate-chip"><span class="rate-pair">USD → ILS</span><span class="rate-val">—</span></div>
        </div>
      </div>

      <div class="sell-card">
        <div class="sell-card-head">
          <span class="sell-card-label">Popular family destinations</span>
          <span class="sell-card-meta">Estimated trip cost · family of 4 · 7 nights · rotates every 20s</span>
        </div>
        <div class="deal-row" id="sell-deals-row"></div>
      </div>
    </div>
  </section>
</div>

<!-- ═══ PAGE 2: PROFILE SETUP ═══════════════════════════════════════════════ -->
<div id="page-profile" class="page">
  <div class="profile-card">
    <div class="profile-header">
      <h2>Set up your family profile</h2>
      <p>Help us personalise your travel recommendations</p>
    </div>

    <div class="field-group">
      <label class="field-label" for="pf-name">Your Full Name</label>
      <input class="field-input" id="pf-name" type="text" placeholder="Jane Smith" autocomplete="name" />
    </div>

    <div class="field-group">
      <label class="field-label" for="pf-city">Home City</label>
      <input class="field-input" id="pf-city" type="text" placeholder="London, UK" autocomplete="address-level2" />
    </div>

    <div class="field-group">
      <label class="field-label" for="pf-age">Your Age</label>
      <input class="field-input" id="pf-age" type="number" placeholder="35" min="18" max="100" style="max-width:120px" />
    </div>

    <div class="field-group" style="display:flex;gap:32px;flex-wrap:wrap">
      <div>
        <label class="field-label">Adults in family</label>
        <div class="stepper">
          <button class="stepper-btn" onclick="step('adults',-1)">-</button>
          <div class="stepper-val" id="val-adults">2</div>
          <button class="stepper-btn" onclick="step('adults',1)">+</button>
        </div>
      </div>
      <div>
        <label class="field-label">Children</label>
        <div class="stepper">
          <button class="stepper-btn" onclick="step('children',-1)">-</button>
          <div class="stepper-val" id="val-children">0</div>
          <button class="stepper-btn" onclick="step('children',1)">+</button>
        </div>
      </div>
    </div>

    <div class="field-group" id="ages-field" style="display:none">
      <label class="field-label" for="pf-child-ages">Children's Ages</label>
      <input class="field-input" id="pf-child-ages" type="text" placeholder="e.g. 5, 8, 12" />
    </div>

    <div class="field-group">
      <label class="field-label">Dietary Requirements</label>
      <div class="chip-group" id="dietary-chips">
        <span class="chip selected" data-val="None" onclick="toggleDiet(this)">None</span>
        <span class="chip" data-val="Kosher" onclick="toggleDiet(this)">Kosher</span>
        <span class="chip" data-val="Halal" onclick="toggleDiet(this)">Halal</span>
        <span class="chip" data-val="Vegetarian" onclick="toggleDiet(this)">Vegetarian</span>
        <span class="chip" data-val="Vegan" onclick="toggleDiet(this)">Vegan</span>
        <span class="chip" data-val="Gluten-free" onclick="toggleDiet(this)">Gluten-free</span>
        <span class="chip" data-val="Nut-free" onclick="toggleDiet(this)">Nut-free</span>
      </div>
    </div>

    <div class="field-group">
      <label class="field-label">Travel Style</label>
      <div class="style-cards" id="style-cards">
        <div class="style-card selected" data-val="Relaxed Family" onclick="selectStyle(this)">
          <div class="sc-icon" style="background:rgba(16,185,129,0.18)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7d8c5c" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          </div>
          <div class="sc-label">Relaxed Family</div>
          <div class="sc-desc">Easygoing pace, comfort first</div>
        </div>
        <div class="style-card" data-val="Adventure" onclick="selectStyle(this)">
          <div class="sc-icon" style="background:rgba(245,158,11,0.18)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          </div>
          <div class="sc-label">Adventure</div>
          <div class="sc-desc">Hiking, outdoor thrills</div>
        </div>
        <div class="style-card" data-val="Cultural" onclick="selectStyle(this)">
          <div class="sc-icon" style="background:rgba(139,92,246,0.18)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9b89a6" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="12" y1="22" x2="12" y2="12"/></svg>
          </div>
          <div class="sc-label">Cultural</div>
          <div class="sc-desc">Museums, history, arts</div>
        </div>
        <div class="style-card" data-val="Beach and Nature" onclick="selectStyle(this)">
          <div class="sc-icon" style="background:rgba(14,165,233,0.18)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#97a87f" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          </div>
          <div class="sc-label">Beach and Nature</div>
          <div class="sc-desc">Sun, sea, national parks</div>
        </div>
      </div>
    </div>

    <div class="field-group">
      <label class="field-label">Budget</label>
      <div class="chip-group" id="budget-chips">
        <span class="chip" data-val="Budget-friendly" onclick="selectBudget(this)">Budget-friendly</span>
        <span class="chip selected" data-val="Moderate" onclick="selectBudget(this)">Moderate</span>
        <span class="chip" data-val="Premium" onclick="selectBudget(this)">Premium</span>
      </div>
    </div>

    <button class="btn-start" onclick="saveProfile()">Start Planning</button>
  </div>
</div>

<!-- ═══ PAGE 3: CHAT APP ═════════════════════════════════════════════════════ -->
<div id="page-app" class="page" style="flex-direction:column">

  <header class="app-header">
    <div class="app-brand">FamilyTripAI</div>
    <nav class="app-nav">
      <button class="nav-tab active" data-tab="dashboard" onclick="switchTab('dashboard')">Dashboard</button>
      <button class="nav-tab" data-tab="chat" onclick="switchTab('chat')">Chat</button>
      <button class="nav-tab" data-tab="trips" onclick="switchTab('trips')">Trips</button>
      <button class="nav-tab" data-tab="prices" onclick="switchTab('prices')">Prices</button>
      <button class="nav-tab" data-tab="forme" onclick="switchTab('forme')">For Me</button>
      <button class="nav-tab" data-tab="globe" onclick="switchTab('globe')">Explore Globe</button>
    </nav>
    <div class="app-header-right">
      <span class="key-pill missing" id="key-status">No key set</span>
      <div class="user-avatar" id="user-avatar">?</div>
      <span class="user-name" id="user-name-display"></span>
      <button class="settings-btn" title="Settings" onclick="openSettings()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
    </div>
  </header>

  <!-- TAB: Dashboard -->
  <div class="tab-panel active" id="tab-dashboard" data-tab="dashboard">
    <div class="dash-wrap">
      <div class="dash-inner">
        <div class="dash-greeting">
          <h2 id="dash-greeting-h">Welcome back</h2>
          <p id="dash-greeting-p">Here's a quick look at what FamilyTripAI can plan for you next.</p>
        </div>

        <div class="dash-section-label">Jump back in</div>
        <div class="dash-quick-row">
          <div class="dash-quick-card" onclick="switchTab('chat')">
            <h3>Plan a trip</h3>
            <p>Chat with the AI and get a full day-by-day family itinerary.</p>
          </div>
          <div class="dash-quick-card" onclick="switchTab('trips')">
            <h3>Browse trips</h3>
            <p>Search and compare flights, hotels and activities.</p>
          </div>
          <div class="dash-quick-card" onclick="switchTab('prices')">
            <h3>Check prices</h3>
            <p>Live currency rates and estimated costs for popular destinations.</p>
          </div>
          <div class="dash-quick-card" onclick="switchTab('forme')">
            <h3>For Me</h3>
            <p>Personalised picks based on your travel profile.</p>
          </div>
          <div class="dash-quick-card" onclick="switchTab('globe')">
            <h3>Explore the globe</h3>
            <p>Spin a 3D globe of family-friendly destinations worldwide.</p>
          </div>
        </div>

        <div class="dash-section-label">Featured destinations</div>
        <div class="dash-photo-grid" id="dash-photo-grid"></div>
      </div>
    </div>
  </div>

  <!-- TAB: Chat -->
  <div class="tab-panel" id="tab-chat" data-tab="chat">
    <div class="chat-body">
      <div id="messages" role="log" aria-live="polite" aria-label="Conversation with FamilyTripAI">
        <div class="welcome" id="welcome">
          <div class="welcome-logo">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          </div>
          <h2 id="welcome-heading">Where is your family headed?</h2>
          <p id="welcome-sub">Tell me your destination, travel dates, and any preferences. I will search flights, hotels, weather, activities, restaurants and build you a complete family itinerary.</p>
          <div class="profile-chips" id="welcome-chips"></div>
        </div>
      </div>

      <div class="input-area">
        <div class="suggestions" role="list" aria-label="Example trips">
          <span class="suggestion" role="button" tabindex="0" onclick="fill(this)">Week in Paris, 2 adults 2 kids</span>
          <span class="suggestion" role="button" tabindex="0" onclick="fill(this)">5 days in Bali from London, July 2026</span>
          <span class="suggestion" role="button" tabindex="0" onclick="fill(this)">Thailand 4 weeks, 7 people, kosher, kids 5-15</span>
          <span class="suggestion" role="button" tabindex="0" onclick="fill(this)">Japan family trip with toddlers, September</span>
        </div>
        <div class="input-row">
          <textarea id="user-input" rows="1" aria-label="Describe your trip" placeholder="Describe your trip — destination, dates, family size..."></textarea>
          <button id="send-btn" aria-label="Send message" onclick="send()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB: Trips — browse & filter flights / hotels / activities -->
  <div class="tab-panel" id="tab-trips" data-tab="trips">
    <div class="browse-wrap">
      <div class="browse-inner">
        <div class="browse-heading">
          <h2>Browse your trip</h2>
          <p>Search flights, hotels and activities, then filter and sort the results to fit your family.</p>
        </div>

        <div class="subnav">
          <button class="subnav-btn active" data-cat="flights" onclick="switchCategory('trips','flights')">Flights</button>
          <button class="subnav-btn" data-cat="hotels" onclick="switchCategory('trips','hotels')">Hotels</button>
          <button class="subnav-btn" data-cat="activities" onclick="switchCategory('trips','activities')">Activities</button>
        </div>

        <form class="search-form" id="trips-form-flights" onsubmit="return submitSearch(event,'trips','flights')">
          <input name="origin" placeholder="From (city or airport)" list="airport-list" autocomplete="off" required />
          <input name="destination" placeholder="To (city or airport)" list="airport-list" autocomplete="off" required />
          <input type="date" name="departure_date" required />
          <input type="date" name="return_date" />
          <input type="number" name="passengers" min="1" value="1" title="Passengers" />
          <button type="submit">Search flights</button>
        </form>

        <form class="search-form hidden" id="trips-form-hotels" onsubmit="return submitSearch(event,'trips','hotels')">
          <input name="location" placeholder="Destination" required />
          <input type="date" name="checkin" required />
          <input type="date" name="checkout" required />
          <input type="number" name="guests" min="1" value="2" title="Guests" />
          <input type="number" name="rooms" min="1" value="1" title="Rooms" />
          <button type="submit">Search hotels</button>
        </form>

        <form class="search-form hidden" id="trips-form-activities" onsubmit="return submitSearch(event,'trips','activities')">
          <input name="location" placeholder="Destination" required />
          <input name="activity_type" placeholder="Type — family, adventure, cultural, beach..." value="family" />
          <button type="submit">Find activities</button>
        </form>

        <div class="filter-bar hidden" id="trips-filters">
          <label>Sort
            <select id="trips-sort" onchange="applyBrowseFilters('trips')">
              <option value="price-asc">Price: low to high</option>
              <option value="price-desc">Price: high to low</option>
              <option value="rating-desc">Rating: best first</option>
            </select>
          </label>
          <label>Max price (USD)
            <input type="range" id="trips-maxprice" min="0" max="3000" step="50" value="3000" oninput="applyBrowseFilters('trips')" />
            <span id="trips-maxprice-val">3000</span>
          </label>
          <label class="hidden" id="trips-stops-wrap">Max stops
            <select id="trips-stops" onchange="applyBrowseFilters('trips')">
              <option value="9">Any</option>
              <option value="0">Nonstop</option>
              <option value="1">1 or fewer</option>
            </select>
          </label>
        </div>

        <p class="estimate-note">Prices shown are AI-generated planning estimates, not live fares — open a booking link below for real-time prices.</p>
        <div class="booking-links" id="trips-links"></div>
        <div id="trips-results"></div>
      </div>
    </div>
  </div>

  <!-- TAB: Prices — price comparison & budget tools -->
  <div class="tab-panel" id="tab-prices" data-tab="prices">
    <div class="browse-wrap">
      <div class="browse-inner">
        <div class="browse-heading">
          <h2>Prices &amp; budget</h2>
          <p>Compare flight and hotel price ranges, sorted cheapest first, and check live currency rates.</p>
        </div>

        <div class="price-tools">
          <div class="price-tool-card">
            <h3>Currency converter</h3>
            <div class="pt-row">
              <input id="price-curr-amount" type="number" value="100" min="0" />
              <select id="price-curr-from">
                <option>USD</option><option>EUR</option><option>GBP</option><option>ILS</option>
                <option>JPY</option><option>AUD</option><option>CAD</option><option>THB</option>
              </select>
              <span style="align-self:center;color:var(--text-muted)">→</span>
              <select id="price-curr-to">
                <option>EUR</option><option>USD</option><option>GBP</option><option>ILS</option>
                <option>JPY</option><option>AUD</option><option>CAD</option><option>THB</option>
              </select>
              <button onclick="convertCurrency()">Convert</button>
            </div>
            <div class="price-tool-result" id="price-curr-result"></div>
          </div>

          <div class="price-tool-card">
            <h3>Trip budget estimator</h3>
            <div class="budget-grid">
              <label>Travellers<input id="bud-people" type="number" min="1" value="4" /></label>
              <label>Nights<input id="bud-nights" type="number" min="1" value="7" /></label>
              <label>Flights / person<input id="bud-flight" type="number" min="0" value="450" /></label>
              <label>Hotel / night<input id="bud-hotel" type="number" min="0" value="180" /></label>
              <label>Activities / person / day<input id="bud-activities" type="number" min="0" value="35" /></label>
              <label>Food / person / day<input id="bud-food" type="number" min="0" value="45" /></label>
              <label>Show in
                <select id="bud-currency">
                  <option>USD</option><option>EUR</option><option>GBP</option><option>ILS</option>
                  <option>JPY</option><option>AUD</option><option>CAD</option><option>THB</option>
                </select>
              </label>
            </div>
            <button onclick="estimateBudget()">Estimate total</button>
            <div class="price-tool-result" id="price-bud-result"></div>
          </div>
        </div>

        <div class="subnav">
          <button class="subnav-btn active" data-cat="flights" onclick="switchCategory('prices','flights')">Flight prices</button>
          <button class="subnav-btn" data-cat="hotels" onclick="switchCategory('prices','hotels')">Hotel prices</button>
        </div>

        <form class="search-form" id="prices-form-flights" onsubmit="return submitSearch(event,'prices','flights')">
          <input name="origin" placeholder="From (city or airport)" list="airport-list" autocomplete="off" required />
          <input name="destination" placeholder="To (city or airport)" list="airport-list" autocomplete="off" required />
          <input type="date" name="departure_date" required />
          <input type="date" name="return_date" />
          <input type="number" name="passengers" min="1" value="1" title="Passengers" />
          <button type="submit">Compare prices</button>
        </form>

        <form class="search-form hidden" id="prices-form-hotels" onsubmit="return submitSearch(event,'prices','hotels')">
          <input name="location" placeholder="Destination" required />
          <input type="date" name="checkin" required />
          <input type="date" name="checkout" required />
          <input type="number" name="guests" min="1" value="2" title="Guests" />
          <input type="number" name="rooms" min="1" value="1" title="Rooms" />
          <button type="submit">Compare prices</button>
        </form>

        <div class="filter-bar hidden" id="prices-filters">
          <label>Sort
            <select id="prices-sort" onchange="applyBrowseFilters('prices')">
              <option value="price-asc" selected>Price: low to high</option>
              <option value="price-desc">Price: high to low</option>
              <option value="rating-desc">Rating: best first</option>
            </select>
          </label>
          <label>Max price (USD)
            <input type="range" id="prices-maxprice" min="0" max="3000" step="50" value="3000" oninput="applyBrowseFilters('prices')" />
            <span id="prices-maxprice-val">3000</span>
          </label>
        </div>

        <p class="estimate-note">Prices shown are AI-generated planning estimates, not live fares — open a booking link below for real-time prices.</p>
        <div class="booking-links" id="prices-links"></div>
        <div id="prices-results"></div>
      </div>
    </div>
  </div>

  <!-- TAB: For Me — personalised picks based on profile -->
  <div class="tab-panel" id="tab-forme" data-tab="forme">
    <div class="browse-wrap">
      <div class="browse-inner">
        <div class="browse-heading">
          <h2>For you</h2>
          <p>Destination ideas curated around your family's profile — ages, dietary needs, style and budget.</p>
        </div>
        <div class="search-form" style="justify-content:flex-end">
          <button type="button" onclick="loadRecommendations()" id="forme-btn">Get personalised picks</button>
        </div>
        <div id="forme-results"></div>
      </div>
    </div>
  </div>

  <div class="tab-panel" id="tab-globe" data-tab="globe">
    <div class="browse-wrap">
      <div class="browse-inner">
        <div class="browse-heading">
          <h2>Explore the globe</h2>
          <p>Spin the globe and see how family-friendly each destination is — color-coded from great fits to ones that need more planning. Click a dot for details.</p>
        </div>
        <div class="globe-legend">
          <span><i style="background:#8ea06f"></i> Great for families</span>
          <span><i style="background:#c97b5f"></i> Good, plan ahead</span>
          <span><i style="background:#b85c4a"></i> More involved trip</span>
        </div>
        <div id="globe-viz" class="globe-viz"></div>
      </div>
    </div>
  </div>

</div>

<!-- Settings modal -->
<div class="modal-overlay" id="modal" onclick="maybeClose(event)">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <h2 id="modal-title">Add your free Groq API key</h2>
    <p>
      The AI planner runs on Groq's free LLM API — it takes about a minute to set up and never asks for a credit card:
    </p>
    <ol style="margin: 0 0 14px 18px; padding: 0; color: var(--text-muted, #ddd2c4); font-size: 0.92rem; line-height: 1.6;">
      <li>Open <a href="https://console.groq.com/keys" target="_blank">console.groq.com/keys</a> and sign up free</li>
      <li>Click "Create API Key" and copy it (starts with <code>gsk_</code>)</li>
      <li>Paste it below and hit Save — that's it</li>
    </ol>
    <p style="font-size: 0.85rem; color: var(--text-dim, #756c60);">Your key is stored only in your browser — it's never sent anywhere except directly to Groq.</p>
    <input type="password" class="modal-input" id="key-input" placeholder="gsk_..." autocomplete="off" />
    <div class="modal-actions">
      <button class="mbtn mbtn-danger" onclick="clearKey()">Clear key</button>
      <button class="mbtn mbtn-secondary" onclick="closeSettings()">Cancel</button>
      <button class="mbtn mbtn-primary" onclick="saveKey()">Save</button>
    </div>
  </div>
</div>

<!-- Account creation modal (Continue with Google/Apple) -->
<div class="modal-overlay" id="account-modal" onclick="maybeCloseAccount(event)">
  <div class="modal">
    <h2 id="account-modal-title">Continue with Google</h2>
    <p>
      We can't run real Google/Apple sign-in here (that needs paid developer
      credentials), so let's create your FamilyTripAI account directly — it's
      saved securely in your browser, completely free.
    </p>
    <input type="text" class="modal-input" id="account-name-input" placeholder="Your name" autocomplete="name" />
    <input type="email" class="modal-input" id="account-email-input" placeholder="you@example.com" autocomplete="email" style="margin-top:10px;" />
    <p id="account-modal-error" style="color:var(--accent); display:none; margin-top:8px; font-size:0.9rem;"></p>
    <div class="modal-actions">
      <button class="mbtn mbtn-secondary" onclick="closeAccountModal()">Cancel</button>
      <button class="mbtn mbtn-primary" onclick="createAccount()">Create account</button>
    </div>
  </div>
</div>

<!-- Result detail popup (flight / hotel / activity) -->
<div class="modal-overlay" id="detail-modal" onclick="maybeCloseDetail(event)">
  <div class="modal detail-modal">
    <div id="detail-modal-body"></div>
    <div class="modal-actions">
      <button class="mbtn mbtn-secondary" onclick="closeDetailModal()">Close</button>
    </div>
  </div>
</div>

<!-- Toast notification -->
<div class="toast" id="toast"></div>

<script>
  if (typeof marked !== 'undefined' && marked.setOptions) marked.setOptions({ breaks: true });

  // Register the service worker for installability + an offline app shell.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  // Model output (and any web-search text it echoes back) is untrusted, so the
  // rendered HTML is always run through DOMPurify before it touches innerHTML.
  // This is the single chokepoint for all bot/markdown rendering — keep it that way.
  function sanitizeHtml(html) {
    if (typeof DOMPurify !== 'undefined' && DOMPurify.sanitize) {
      return DOMPurify.sanitize(html, {
        ADD_ATTR: ['target', 'rel'],
        FORBID_TAGS: ['style', 'form', 'input', 'button'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'style']
      });
    }
    return html;
  }

  function mdParse(text) {
    if (typeof marked !== 'undefined' && marked.parse) {
      try { return sanitizeHtml(marked.parse(text == null ? '' : text)); } catch (_) {}
    }
    return escHtml(text == null ? '' : text).replace(/\\n/g, '<br>');
  }

  // ── Page management ──────────────────────────────────────────────────────
  function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  // ── Hero slideshow (cinematic crossfade + Ken Burns) ─────────────────────
  // ── Real airports for the flight-search dropdown ─────────────────────────
  // A curated list of major world airports (IATA code, city, country, name) so
  // users can pick from real options instead of guessing exact spellings.
  const AIRPORTS = [
    ['JFK','New York','USA','John F. Kennedy Intl'], ['LGA','New York','USA','LaGuardia'],
    ['EWR','Newark','USA','Newark Liberty Intl'], ['LAX','Los Angeles','USA','Los Angeles Intl'],
    ['ORD','Chicago','USA',"O'Hare Intl"], ['SFO','San Francisco','USA','San Francisco Intl'],
    ['MIA','Miami','USA','Miami Intl'], ['BOS','Boston','USA','Logan Intl'],
    ['SEA','Seattle','USA','Seattle-Tacoma Intl'], ['ATL','Atlanta','USA',"Hartsfield-Jackson Intl"],
    ['DFW','Dallas','USA','Dallas/Fort Worth Intl'], ['IAH','Houston','USA','George Bush Intercontinental'],
    ['LAS','Las Vegas','USA','Harry Reid Intl'], ['MCO','Orlando','USA','Orlando Intl'],
    ['YYZ','Toronto','Canada','Toronto Pearson Intl'], ['YVR','Vancouver','Canada','Vancouver Intl'],
    ['MEX','Mexico City','Mexico','Mexico City Intl'], ['GRU','São Paulo','Brazil','Guarulhos Intl'],
    ['EZE','Buenos Aires','Argentina','Ministro Pistarini Intl'],
    ['LHR','London','UK','Heathrow'], ['LGW','London','UK','Gatwick'], ['LTN','London','UK','Luton'],
    ['CDG','Paris','France','Charles de Gaulle'], ['ORY','Paris','France','Orly'],
    ['AMS','Amsterdam','Netherlands','Schiphol'], ['FRA','Frankfurt','Germany','Frankfurt Airport'],
    ['MUC','Munich','Germany','Munich Airport'], ['MAD','Madrid','Spain','Adolfo Suárez Madrid–Barajas'],
    ['BCN','Barcelona','Spain','El Prat'], ['FCO','Rome','Italy','Leonardo da Vinci–Fiumicino'],
    ['MXP','Milan','Italy','Malpensa'], ['ZRH','Zurich','Switzerland','Zurich Airport'],
    ['VIE','Vienna','Austria','Vienna Intl'], ['CPH','Copenhagen','Denmark','Copenhagen Airport'],
    ['ARN','Stockholm','Sweden','Arlanda'], ['OSL','Oslo','Norway','Gardermoen'],
    ['HEL','Helsinki','Finland','Helsinki Airport'], ['DUB','Dublin','Ireland','Dublin Airport'],
    ['LIS','Lisbon','Portugal','Humberto Delgado'], ['ATH','Athens','Greece','Eleftherios Venizelos'],
    ['IST','Istanbul','Turkey','Istanbul Airport'], ['WAW','Warsaw','Poland','Chopin Airport'],
    ['PRG','Prague','Czechia','Václav Havel Airport'], ['BUD','Budapest','Hungary','Budapest Ferenc Liszt Intl'],
    ['KEF','Reykjavik','Iceland','Keflavík Intl'],
    ['TLV','Tel Aviv','Israel','Ben Gurion Airport'], ['DXB','Dubai','UAE','Dubai Intl'],
    ['AUH','Abu Dhabi','UAE','Abu Dhabi Intl'], ['DOH','Doha','Qatar','Hamad Intl'],
    ['CAI','Cairo','Egypt','Cairo Intl'], ['CMN','Casablanca','Morocco','Mohammed V Intl'],
    ['JNB','Johannesburg','South Africa','OR Tambo Intl'], ['CPT','Cape Town','South Africa','Cape Town Intl'],
    ['NBO','Nairobi','Kenya','Jomo Kenyatta Intl'],
    ['DEL','Delhi','India','Indira Gandhi Intl'], ['BOM','Mumbai','India','Chhatrapati Shivaji Maharaj Intl'],
    ['BKK','Bangkok','Thailand','Suvarnabhumi'], ['SIN','Singapore','Singapore','Changi'],
    ['KUL','Kuala Lumpur','Malaysia','Kuala Lumpur Intl'], ['CGK','Jakarta','Indonesia','Soekarno-Hatta Intl'],
    ['DPS','Bali','Indonesia','Ngurah Rai Intl'], ['MNL','Manila','Philippines','Ninoy Aquino Intl'],
    ['HKG','Hong Kong','China','Hong Kong Intl'], ['PVG','Shanghai','China','Pudong Intl'],
    ['PEK','Beijing','China','Capital Intl'], ['ICN','Seoul','South Korea','Incheon Intl'],
    ['NRT','Tokyo','Japan','Narita Intl'], ['HND','Tokyo','Japan','Haneda Airport'],
    ['KIX','Osaka','Japan','Kansai Intl'], ['TPE','Taipei','Taiwan','Taoyuan Intl'],
    ['SYD','Sydney','Australia','Kingsford Smith'], ['MEL','Melbourne','Australia','Melbourne Airport'],
    ['BNE','Brisbane','Australia','Brisbane Airport'], ['AKL','Auckland','New Zealand','Auckland Airport'],
    ['ZQN','Queenstown','New Zealand','Queenstown Airport'],
    ['GIG','Rio de Janeiro','Brazil','Galeão Intl'], ['LIM','Lima','Peru','Jorge Chávez Intl'],
    ['BOG','Bogotá','Colombia','El Dorado Intl'], ['SJO','San José','Costa Rica','Juan Santamaría Intl']
  ];

  function initAirportList() {
    const list = document.getElementById('airport-list');
    if (!list || list.dataset.ready) return;
    list.dataset.ready = '1';
    list.innerHTML = AIRPORTS.map(([code, city, country, name]) =>
      '<option value="' + escAttr(city + ' (' + code + ')') + '">' + escHtml(name + ' · ' + country) + '</option>'
    ).join('');
  }

  const HERO_SLIDES = [
    { seed: 11, prompt: 'Great Wall of China winding through misty green mountains aerial view golden morning light professional travel photography' },
    { seed: 91, prompt: 'Florence Italy skyline Duomo cathedral terracotta dome golden sunset rooftop view professional travel photography editorial' },
    { seed: 22, prompt: 'Shanghai China Yu Garden bazaar glowing lanterns dusk traditional architecture crowds professional travel photography editorial' },
    { seed: 92, prompt: 'Thailand longtail boat turquoise water limestone karst cliffs woman traveller professional travel photography editorial' },
    { seed: 93, prompt: 'Berlin Germany sunset cityscape river Spree bridges golden hour skyline reflections professional travel photography editorial' },
    { seed: 33, prompt: 'Santorini Greece white houses blue domes cliffside sunset professional travel photography editorial' },
    { seed: 44, prompt: 'Paris Eiffel Tower Seine river golden hour romantic professional travel photography editorial' },
    { seed: 55, prompt: 'Bali Indonesia emerald rice terraces morning mist tropical professional travel photography editorial' }
  ];

  function initHeroSlideshow() {
    const stage = document.getElementById('hero-slideshow');
    const dots = document.getElementById('hero-dots');
    if (!stage || !dots || stage.dataset.ready) return;
    stage.dataset.ready = '1';

    HERO_SLIDES.forEach((slide, i) => {
      const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(slide.prompt) +
                  '?width=1600&height=1000&nologo=true&seed=' + slide.seed;
      const div = document.createElement('div');
      div.className = 'hero-slide' + (i === 0 ? ' active' : '');
      stage.appendChild(div);

      // Keep the gradient placeholder visible until the photo actually loads —
      // avoids a blank/broken slide if pollinations.ai is slow or unreachable.
      const preload = new Image();
      preload.onload = () => { div.style.backgroundImage = "url('" + url + "')"; };
      preload.onerror = () => { /* keep gradient fallback */ };
      preload.src = url;

      const dot = document.createElement('span');
      dot.className = 'hero-dot' + (i === 0 ? ' active' : '');
      dots.appendChild(dot);
    });

    const slideEls = stage.querySelectorAll('.hero-slide');
    const dotEls = dots.querySelectorAll('.hero-dot');
    let current = 0;

    setInterval(() => {
      slideEls[current].classList.remove('active');
      dotEls[current].classList.remove('active');
      current = (current + 1) % slideEls.length;
      slideEls[current].classList.add('active');
      dotEls[current].classList.add('active');
    }, 6000);
  }

  // ── Dashboard: featured-destination gallery (home page) ──────────────────
  const DASH_DESTINATIONS = [
    { name: 'Great Wall, China', blurb: 'Hike the ancient wall through misty mountains', seed: 11,
      prompt: 'Great Wall of China winding through misty green mountains aerial view golden morning light professional travel photography',
      ask: 'Plan a family trip to the Great Wall of China and Beijing' },
    { name: 'Florence, Italy', blurb: 'Renaissance art, gelato and that famous skyline', seed: 91,
      prompt: 'Florence Italy skyline Duomo cathedral terracotta dome golden sunset rooftop view professional travel photography editorial',
      ask: 'Plan a family trip to Florence, Italy' },
    { name: 'Shanghai, China', blurb: 'Glowing lanterns and bazaars at the Yu Garden', seed: 22,
      prompt: 'Shanghai China Yu Garden bazaar glowing lanterns dusk traditional architecture crowds professional travel photography editorial',
      ask: 'Plan a family trip to Shanghai, China' },
    { name: 'Krabi, Thailand', blurb: 'Longtail boats among turquoise limestone cliffs', seed: 92,
      prompt: 'Thailand longtail boat turquoise water limestone karst cliffs woman traveller professional travel photography editorial',
      ask: 'Plan a family trip to Krabi, Thailand' },
    { name: 'Berlin, Germany', blurb: 'Riverside sunsets, history and bridges', seed: 93,
      prompt: 'Berlin Germany sunset cityscape river Spree bridges golden hour skyline reflections professional travel photography editorial',
      ask: 'Plan a family trip to Berlin, Germany' }
  ];

  function planFromDashboard(ask) {
    switchTab('chat');
    inputEl.value = ask;
    inputEl.focus();
    resize();
  }

  function initDashboard() {
    const grid = document.getElementById('dash-photo-grid');
    if (!grid || grid.dataset.ready) return;
    grid.dataset.ready = '1';

    DASH_DESTINATIONS.forEach((d) => {
      const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(d.prompt) +
                  '?width=600&height=420&nologo=true&seed=' + d.seed;
      const card = document.createElement('div');
      card.className = 'dash-photo-card';
      card.innerHTML = '<div class="dash-photo-overlay"><h3>' + escHtml(d.name) + '</h3>' +
        '<p>' + escHtml(d.blurb) + '</p><span class="dpc-cta">Plan a trip here &rarr;</span></div>';
      card.addEventListener('click', () => planFromDashboard(d.ask));
      grid.appendChild(card);

      const preload = new Image();
      preload.onload = () => { card.style.backgroundImage = "url('" + url + "')"; };
      preload.onerror = () => { /* keep gradient fallback */ };
      preload.src = url;
    });
  }

  // ── Selling section: live currency ticker + rotating destination prices ──
  const SELL_PAIRS = [['USD', 'EUR'], ['USD', 'GBP'], ['USD', 'JPY'], ['USD', 'ILS']];

  async function fetchRates(base) {
    try {
      const res = await fetch('https://open.er-api.com/v6/latest/' + encodeURIComponent(base));
      const data = await res.json();
      if (data && data.rates) return data.rates;
      throw new Error('no rates');
    } catch (_) {
      const res2 = await fetch('https://api.frankfurter.dev/v1/latest?base=' + encodeURIComponent(base));
      const data2 = await res2.json();
      if (data2 && data2.rates) return data2.rates;
      throw new Error('no rates');
    }
  }

  async function loadSellRates() {
    const row = document.getElementById('sell-rates-row');
    const meta = document.getElementById('sell-rates-meta');
    if (!row) return;
    try {
      const rates = await fetchRates('USD');
      const chips = row.querySelectorAll('.rate-chip');
      SELL_PAIRS.forEach(([from, to], i) => {
        const rate = rates[to];
        const valEl = chips[i] && chips[i].querySelector('.rate-val');
        if (valEl) valEl.textContent = (rate != null) ? rate.toFixed(3) : '—';
      });
      if (meta) meta.textContent = 'Live · updated ' + new Date().toLocaleTimeString();
    } catch (err) {
      if (meta) meta.textContent = 'Live rates temporarily unavailable';
    }
  }

  const SELL_DEALS = [
    { city: 'Lisbon, Portugal',          range: '$1,450 – $2,100' },
    { city: 'Tokyo, Japan',              range: '$3,200 – $4,800' },
    { city: 'Costa Rica',                range: '$2,600 – $3,900' },
    { city: 'Barcelona, Spain',          range: '$1,800 – $2,650' },
    { city: 'Cape Town, South Africa',   range: '$2,100 – $3,300' },
    { city: 'Reykjavik, Iceland',        range: '$2,900 – $4,200' },
    { city: 'Bangkok, Thailand',         range: '$1,650 – $2,400' },
    { city: 'Queenstown, New Zealand',   range: '$3,500 – $5,100' },
    { city: 'Dubai, UAE',                range: '$2,800 – $4,300' },
    { city: 'Mexico City, Mexico',       range: '$1,400 – $2,050' },
    { city: 'Rome, Italy',               range: '$1,950 – $2,800' },
    { city: 'Marrakech, Morocco',        range: '$1,350 – $1,950' }
  ];
  let sellDealOffset = 0;

  function renderSellDeals() {
    const row = document.getElementById('sell-deals-row');
    if (!row) return;
    const picks = [];
    for (let i = 0; i < 3; i++) picks.push(SELL_DEALS[(sellDealOffset + i) % SELL_DEALS.length]);
    sellDealOffset = (sellDealOffset + 3) % SELL_DEALS.length;

    row.querySelectorAll('.deal-card').forEach(c => c.classList.add('refreshing'));
    setTimeout(() => {
      row.innerHTML = picks.map(d =>
        '<div class="deal-card refreshing"><div class="deal-city">' + escHtml(d.city) + '</div>' +
        '<div class="deal-range">' + escHtml(d.range) + '</div>' +
        '<div class="deal-note">est. per family of 4 · 7 nights</div></div>'
      ).join('');
      requestAnimationFrame(() => {
        row.querySelectorAll('.deal-card').forEach(c => c.classList.remove('refreshing'));
      });
    }, 220);
  }

  function initSellSection() {
    const section = document.querySelector('.sell-section');
    if (!section || section.dataset.ready) return;
    section.dataset.ready = '1';

    renderSellDeals();
    loadSellRates();

    setInterval(renderSellDeals, 20000);
    setInterval(loadSellRates, 20000);
  }

  // ── Explore globe: 3D globe with color-coded family-fit destinations ─────
  const GLOBE_DESTINATIONS = [
    { name: 'Orlando, USA',            lat: 28.5383,  lng: -81.3792,  fit: 10, why: 'Theme-park capital — purpose-built for family fun.' },
    { name: 'Singapore',               lat: 1.3521,   lng: 103.8198,  fit: 9,  why: 'Spotless, safe and packed with family attractions.' },
    { name: 'Paris, France',           lat: 48.8566,  lng: 2.3522,    fit: 9,  why: 'Easy transit, parks and museums for every age.' },
    { name: 'Costa Rica',              lat: 9.7489,   lng: -83.7534,  fit: 9,  why: 'Wildlife and beaches — brilliant for active families.' },
    { name: 'Tokyo, Japan',            lat: 35.6762,  lng: 139.6503,  fit: 8,  why: 'Safe, clean, incredible food — very kid-friendly.' },
    { name: 'Lisbon, Portugal',        lat: 38.7223,  lng: -9.1393,   fit: 8,  why: 'Compact, walkable, sunny and easy on the budget.' },
    { name: 'Sydney, Australia',       lat: -33.8688, lng: 151.2093,  fit: 8,  why: 'Beaches, wildlife parks and an easy pace.' },
    { name: 'Vienna, Austria',         lat: 48.2082,  lng: 16.3738,   fit: 8,  why: 'Elegant, walkable, full of parks and palaces.' },
    { name: 'Dubai, UAE',              lat: 25.2048,  lng: 55.2708,   fit: 8,  why: 'Modern and safe — indoor attractions beat the heat.' },
    { name: 'Rome, Italy',             lat: 41.9028,  lng: 12.4964,   fit: 7,  why: 'History comes alive, though expect lots of walking.' },
    { name: 'Bangkok, Thailand',       lat: 13.7563,  lng: 100.5018,  fit: 7,  why: 'Affordable and vibrant — busy and hot for little ones.' },
    { name: 'Bali, Indonesia',         lat: -8.3405,  lng: 115.0920,  fit: 7,  why: 'Relaxed beaches and culture, but a long-haul flight.' },
    { name: 'Queenstown, New Zealand', lat: -45.0312, lng: 168.6626,  fit: 7,  why: 'Adventure paradise — best suited to older kids.' },
    { name: 'Cape Town, South Africa', lat: -33.9249, lng: 18.4241,   fit: 7,  why: 'Safaris and beaches — check current travel advisories.' },
    { name: 'Reykjavik, Iceland',      lat: 64.1466,  lng: -21.9426,  fit: 6,  why: 'Stunning nature, but long flights and cold weather.' },
    { name: 'Marrakech, Morocco',      lat: 31.6295,  lng: -7.9811,   fit: 6,  why: 'Rich culture — can feel intense for very young kids.' }
  ];

  function fitColor(fit) {
    if (fit >= 8) return '#8ea06f';
    if (fit >= 7) return '#c9a35f';
    return '#c97b5f';
  }

  function fitLabel(fit) {
    if (fit >= 8) return 'Great for families';
    if (fit >= 7) return 'Good — plan ahead';
    return 'More involved trip';
  }

  let globeInstance = null;

  function initGlobe() {
    const el = document.getElementById('globe-viz');
    if (!el || el.dataset.ready) return;

    if (typeof Globe !== 'function') {
      el.dataset.ready = '1';
      el.innerHTML = '<div class="browse-empty">The 3D globe couldn’t load (blocked script). Try refreshing the page.</div>';
      return;
    }

    el.dataset.ready = '1';
    el.innerHTML = '';

    globeInstance = Globe()(el)
      .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
      .backgroundColor('rgba(0,0,0,0)')
      .atmosphereColor('#c97b5f')
      .atmosphereAltitude(0.18)
      .pointsData(GLOBE_DESTINATIONS)
      .pointLat('lat')
      .pointLng('lng')
      .pointColor(d => fitColor(d.fit))
      .pointAltitude(0.02)
      .pointRadius(0.5)
      .pointLabel(d =>
        '<div style="font-family:\\'Montserrat\\',system-ui,sans-serif;background:#3d3a32;color:#f7f1e6;' +
        'padding:10px 14px;border-radius:10px;border:1px solid #4d473c;max-width:230px;line-height:1.4">' +
        '<div style="font-family:\\'Cormorant Garamond\\',Georgia,serif;font-size:1.05rem;font-weight:600;margin-bottom:2px">' + escHtml(d.name) + '</div>' +
        '<div style="font-size:0.76rem;color:' + fitColor(d.fit) + ';font-weight:600;letter-spacing:0.4px;text-transform:uppercase">' +
          'Family fit ' + d.fit + '/10 · ' + escHtml(fitLabel(d.fit)) +
        '</div>' +
        '<div style="font-size:0.78rem;color:#ddd2c4;margin-top:5px">' + escHtml(d.why) + '</div>' +
        '</div>'
      )
      .onPointClick(d => {
        switchTab('chat');
        if (inputEl) {
          inputEl.value = 'Plan a family trip to ' + d.name;
          inputEl.focus();
        }
      })
      .width(el.clientWidth)
      .height(460);

    try {
      const controls = globeInstance.controls();
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.55;
    } catch (_) {}

    window.addEventListener('resize', () => {
      if (globeInstance && el.offsetParent !== null) globeInstance.width(el.clientWidth);
    });
  }

  // ── Profile management ───────────────────────────────────────────────────
  let profile = null;
  try { profile = JSON.parse(localStorage.getItem('familytrip_profile') || 'null'); } catch(_) {}

  let account = null;
  try { account = JSON.parse(localStorage.getItem('familytrip_account') || 'null'); } catch(_) {}

  let counts = { adults: 2, children: 0 };

  function step(field, delta) {
    const min = field === 'adults' ? 1 : 0;
    const max = 10;
    counts[field] = Math.max(min, Math.min(max, counts[field] + delta));
    document.getElementById('val-' + field).textContent = counts[field];
    if (field === 'children') {
      document.getElementById('ages-field').style.display = counts.children > 0 ? '' : 'none';
    }
  }

  function toggleDiet(el) {
    const val = el.dataset.val;
    if (val === 'None') {
      document.querySelectorAll('#dietary-chips .chip').forEach(c => c.classList.remove('selected'));
      el.classList.add('selected');
      return;
    }
    document.querySelectorAll('#dietary-chips .chip[data-val="None"]').forEach(c => c.classList.remove('selected'));
    el.classList.toggle('selected');
    const anySelected = [...document.querySelectorAll('#dietary-chips .chip:not([data-val="None"])')].some(c => c.classList.contains('selected'));
    if (!anySelected) document.querySelector('#dietary-chips .chip[data-val="None"]').classList.add('selected');
  }

  function selectStyle(el) {
    document.querySelectorAll('#style-cards .style-card').forEach(c => c.classList.remove('selected'));
    el.classList.add('selected');
  }

  function selectBudget(el) {
    document.querySelectorAll('#budget-chips .chip').forEach(c => c.classList.remove('selected'));
    el.classList.add('selected');
  }

  function saveProfile() {
    const name = document.getElementById('pf-name').value.trim();
    const city = document.getElementById('pf-city').value.trim();
    if (!name) { showToast('Please enter your name.'); return; }
    if (!city) { showToast('Please enter your home city.'); return; }

    const dietary = [...document.querySelectorAll('#dietary-chips .chip.selected')].map(c => c.dataset.val);
    const style   = (document.querySelector('#style-cards .style-card.selected') || {}).dataset?.val || '';
    const budget  = (document.querySelector('#budget-chips .chip.selected') || {}).dataset?.val || 'Moderate';

    profile = {
      name,
      home_city: city,
      age: document.getElementById('pf-age').value || '',
      adults: counts.adults,
      children: counts.children,
      children_ages: counts.children > 0 ? document.getElementById('pf-child-ages').value.trim() : '',
      dietary,
      travel_style: style,
      budget
    };

    localStorage.setItem('familytrip_profile', JSON.stringify(profile));
    initApp();
    showPage('page-app');
  }

  function guestContinue() {
    profile = { name: 'Guest', adults: 2, children: 0, dietary: ['None'], travel_style: 'Relaxed Family', budget: 'Moderate' };
    initApp();
    showPage('page-app');
  }

  let pendingSignupProvider = '';

  function beginSignup(provider) {
    pendingSignupProvider = provider;
    const existing = loadAccount();
    if (existing && existing.provider === provider) {
      account = existing;
      showToast('Welcome back, ' + existing.name.split(' ')[0] + '!');
      const savedProfile = localStorage.getItem('familytrip_profile');
      if (savedProfile) {
        try { profile = JSON.parse(savedProfile); } catch (_) { profile = null; }
      }
      if (profile) { initApp(); showPage('page-app'); }
      else { showPage('page-profile'); }
      return;
    }
    document.getElementById('account-modal-title').textContent =
      'Continue with ' + (provider === 'google' ? 'Google' : 'Apple');
    document.getElementById('account-name-input').value = '';
    document.getElementById('account-email-input').value = '';
    document.getElementById('account-modal-error').style.display = 'none';
    document.getElementById('account-modal').classList.add('open');
    setTimeout(() => document.getElementById('account-name-input').focus(), 50);
  }

  function closeAccountModal() {
    document.getElementById('account-modal').classList.remove('open');
  }

  function maybeCloseAccount(e) {
    if (e.target === document.getElementById('account-modal')) closeAccountModal();
  }

  function loadAccount() {
    try {
      const raw = localStorage.getItem('familytrip_account');
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function createAccount() {
    const name = document.getElementById('account-name-input').value.trim();
    const email = document.getElementById('account-email-input').value.trim();
    const errEl = document.getElementById('account-modal-error');

    if (!name) {
      errEl.textContent = 'Please enter your name.';
      errEl.style.display = 'block';
      return;
    }
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
      errEl.textContent = 'Please enter a valid email address.';
      errEl.style.display = 'block';
      return;
    }

    account = {
      id: 'acct_' + Math.random().toString(36).slice(2, 10),
      name,
      email,
      provider: pendingSignupProvider || 'email',
      createdAt: new Date().toISOString()
    };
    localStorage.setItem('familytrip_account', JSON.stringify(account));
    closeAccountModal();
    showToast('Account created — welcome, ' + name.split(' ')[0] + '!');
    showPage('page-profile');
  }

  function initApp() {
    const name = profile ? profile.name : 'there';
    const first = name.split(' ')[0];

    document.getElementById('user-avatar').textContent = first[0].toUpperCase();
    document.getElementById('user-name-display').textContent = first;

    if (profile && name !== 'Guest') {
      document.getElementById('welcome-heading').textContent = 'Welcome back, ' + first + '! Where is your family headed?';
    }

    const dashH = document.getElementById('dash-greeting-h');
    const dashP = document.getElementById('dash-greeting-p');
    if (dashH) dashH.textContent = (profile && name !== 'Guest') ? ('Welcome back, ' + first + '!') : 'Welcome to FamilyTripAI';
    if (dashP) dashP.textContent = (profile && profile.home_city)
      ? ('Planning from ' + profile.home_city + ' — here\\'s a quick look at what\\'s next.')
      : 'Here\\'s a quick look at what FamilyTripAI can plan for you next.';
    initDashboard();

    // Profile chips
    const chipsEl = document.getElementById('welcome-chips');
    chipsEl.innerHTML = '';
    if (profile) {
      const parts = [];
      if (profile.adults) parts.push(profile.adults + ' adult' + (profile.adults !== 1 ? 's' : ''));
      if (profile.children) parts.push(profile.children + ' child' + (profile.children !== 1 ? 'ren' : ''));
      if (profile.home_city) parts.push('from ' + profile.home_city);
      const diets = (profile.dietary || []).filter(d => d !== 'None');
      if (diets.length) parts.push(diets.join(', '));
      if (profile.travel_style) parts.push(profile.travel_style);
      if (profile.budget) parts.push(profile.budget);
      parts.forEach(p => {
        const chip = document.createElement('span');
        chip.className = 'profile-chip';
        chip.textContent = p;
        chipsEl.appendChild(chip);
      });
    }

    updateKeyStatus();
  }

  // ── API key management ──────────────────────────────────────────────────
  function getKey() { return localStorage.getItem('groq_api_key') || ''; }

  function updateKeyStatus() {
    const k = getKey();
    const el = document.getElementById('key-status');
    if (!el) return;
    if (k && k.startsWith('gsk_')) {
      el.textContent = 'Key active';
      el.className = 'key-pill active';
    } else {
      el.textContent = 'No key set';
      el.className = 'key-pill missing';
    }
  }

  function openSettings() {
    document.getElementById('key-input').value = getKey();
    document.getElementById('modal').classList.add('open');
    setTimeout(() => { try { document.getElementById('key-input').focus(); } catch (_) {} }, 50);
  }

  function closeSettings() { document.getElementById('modal').classList.remove('open'); }

  function maybeClose(e) { if (e.target === document.getElementById('modal')) closeSettings(); }

  // ── Keyboard accessibility ───────────────────────────────────────────────
  // ESC closes any open modal; Enter/Space activates the role="button" spans
  // (suggestion chips) so the app is fully operable without a mouse.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.getAttribute && e.target.getAttribute('role') === 'button' && e.target.tagName === 'SPAN') {
      e.preventDefault();
      e.target.click();
    }
  });

  function saveKey() {
    const val = document.getElementById('key-input').value.trim();
    if (val) localStorage.setItem('groq_api_key', val);
    closeSettings();
    updateKeyStatus();
  }

  function clearKey() {
    localStorage.removeItem('groq_api_key');
    document.getElementById('key-input').value = '';
    closeSettings();
    updateKeyStatus();
  }

  // ── Toast ───────────────────────────────────────────────────────────────
  let toastTimer;
  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
  }

  // ── Chat ────────────────────────────────────────────────────────────────
  const messagesEl  = document.getElementById('messages');
  const inputEl     = document.getElementById('user-input');
  const sendBtn     = document.getElementById('send-btn');
  let history = [];

  function fill(el) {
    inputEl.value = el.textContent.trim();
    inputEl.focus();
    resize();
  }

  function resize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
  }

  inputEl.addEventListener('input', resize);
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  function removeWelcome() {
    const w = document.getElementById('welcome');
    if (w) w.remove();
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // AI-generated photos occasionally fail to load (slow generation, network) —
  // swap broken <img> elements for a tasteful gradient placeholder instead of
  // leaving a broken-image icon on screen.
  function imgFallback(el, label) {
    if (!el || !el.parentNode) return;
    const div = document.createElement('div');
    div.className = (el.className || '') + ' img-fallback';
    div.textContent = label || 'Photo unavailable';
    el.replaceWith(div);
  }

  function addUser(text) {
    removeWelcome();
    const wrap = document.createElement('div');
    wrap.className = 'msg user';
    wrap.innerHTML = '<div class="msg-avatar">You<\/div><div class="bubble">' + escHtml(text) + '<\/div>';
    messagesEl.appendChild(wrap);
    scroll();
  }

  // Start an empty bot message bubble that we progressively fill in as the
  // stream arrives — gives a ChatGPT-style "thinking, then typing" feel.
  function startBotMessage() {
    const wrap = document.createElement('div');
    wrap.className = 'msg bot';

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = 'AI';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    const thinking = document.createElement('div');
    thinking.className = 'thinking-steps';
    bubble.appendChild(thinking);

    const content = document.createElement('div');
    content.className = 'bot-content';
    bubble.appendChild(content);

    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scroll();
    return { bubble, thinking, content };
  }

  function addThinkingStep(thinking, text) {
    thinking.querySelectorAll('.thought-step.active').forEach(p => {
      p.classList.remove('active');
      p.classList.add('done');
    });
    const step = document.createElement('div');
    step.className = 'thought-step active';
    step.innerHTML = '<span class="thought-dot"></span><span class="thought-text"></span>';
    step.querySelector('.thought-text').textContent = text;
    thinking.appendChild(step);
    scroll();
  }

  function settleThinking(thinking) {
    const steps = thinking.querySelectorAll('.thought-step');
    if (!steps.length) { thinking.remove(); return; }
    steps.forEach(s => { s.classList.remove('active'); s.classList.add('done'); });
    thinking.classList.add('collapsed');
  }

  function addImageToBubble(bubble, url) {
    if (bubble.querySelector('.dest-img') || bubble.querySelector('.img-fallback')) return;
    const img = document.createElement('img');
    img.src = url;
    img.className = 'dest-img';
    img.alt = 'Destination';
    img.loading = 'lazy';
    img.onerror = () => imgFallback(img, 'Destination photo unavailable — try again in a moment');
    bubble.insertBefore(img, bubble.firstChild);
    scroll();
  }

  function addToolTags(bubble, toolsUsed) {
    if (!toolsUsed || !toolsUsed.length || bubble.querySelector('.tools-row')) return;
    const row = document.createElement('div');
    row.className = 'tools-row';
    const seen = new Set();
    toolsUsed.forEach(t => {
      if (seen.has(t.tool)) return;
      seen.add(t.tool);
      const tag = document.createElement('span');
      tag.className = 'tool-tag';
      tag.textContent = t.tool.replace(/_/g, ' ');
      row.appendChild(tag);
    });
    bubble.appendChild(row);
  }

  // ── Itinerary export ───────────────────────────────────────────────────────
  // Once a substantial plan has been produced, offer the user a way to take it
  // with them: print / save as PDF, copy, or download a calendar (.ics) note.
  function addExportBar(bubble, raw) {
    if (!raw || raw.length < 200 || bubble.querySelector('.export-bar')) return;
    const bar = document.createElement('div');
    bar.className = 'export-bar';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Export this itinerary');

    const mk = (label, aria, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'export-btn';
      b.textContent = label;
      b.setAttribute('aria-label', aria);
      b.addEventListener('click', fn);
      return b;
    };

    bar.appendChild(mk('🖨 Print / PDF', 'Print or save this itinerary as a PDF', () => printPlan(raw)));
    bar.appendChild(mk('📋 Copy', 'Copy this itinerary to the clipboard', (e) => copyPlan(raw, e.currentTarget)));
    bar.appendChild(mk('📅 Calendar', 'Download this itinerary as a calendar file', () => downloadIcs(raw)));
    bubble.appendChild(bar);
  }

  function printPlan(raw) {
    const w = window.open('', '_blank');
    if (!w) { showToast('Allow pop-ups to print your itinerary.'); return; }
    const body = mdParse(raw); // already sanitized
    w.document.write(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>FamilyTripAI Itinerary<\\/title>' +
      '<style>body{font-family:Georgia,serif;max-width:780px;margin:40px auto;padding:0 24px;color:#222;line-height:1.6}' +
      'h1,h2,h3{font-family:Helvetica,Arial,sans-serif;color:#111}h1{border-bottom:2px solid #c97b5f;padding-bottom:8px}' +
      'a{color:#a65a3f}img{max-width:100%;border-radius:8px}.brand{color:#c97b5f;font-size:13px;letter-spacing:1px}<\\/style>' +
      '<\\/head><body><p class="brand">FAMILYTRIPAI<\\/p>' + body + '<\\/body><\\/html>'
    );
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch (_) {} }, 350);
  }

  async function copyPlan(raw, btn) {
    try {
      await navigator.clipboard.writeText(raw);
      if (btn) { const o = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = o; }, 1500); }
    } catch (_) {
      showToast('Could not copy — your browser blocked clipboard access.');
    }
  }

  function downloadIcs(raw) {
    const dt = new Date();
    const stamp = dt.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const day = dt.toISOString().slice(0, 10).replace(/-/g, '');
    const esc = (s) => String(s).replace(/\\\\/g, '\\\\\\\\').replace(/\\n/g, '\\\\n').replace(/,/g, '\\\\,').replace(/;/g, '\\\\;');
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FamilyTripAI//EN', 'BEGIN:VEVENT',
      'UID:' + Date.now() + '@familytripai', 'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + day, 'SUMMARY:FamilyTripAI Itinerary',
      'DESCRIPTION:' + esc(raw), 'END:VEVENT', 'END:VCALENDAR'
    ].join('\\r\\n');
    const blob = new Blob([ics], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'familytrip-itinerary.ics';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function scroll() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  async function send() {
    const text = inputEl.value.trim();
    if (!text) return;

    const key = getKey();
    if (!key || !key.startsWith('gsk_')) {
      showToast('Add your free Groq API key to start chatting — takes under a minute.');
      openSettings();
      return;
    }

    inputEl.value = '';
    inputEl.style.height = 'auto';
    sendBtn.disabled = true;

    addUser(text);

    const { bubble, thinking, content } = startBotMessage();
    addThinkingStep(thinking, 'Thinking about your trip…');

    let raw = '';
    let images = [];
    let toolsUsed = [];
    let gotChunks = false;

    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history, api_key: key, user_profile: profile })
      });

      if (!res.ok || !res.body) {
        let data = {};
        try { data = await res.json(); } catch (_) {}
        settleThinking(thinking);
        content.innerHTML = mdParse('**' + escHtml(data.detail || data.error || 'Server error') + '**');
        sendBtn.disabled = false;
        inputEl.focus();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\\n');
        buf = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let evt;
          try { evt = JSON.parse(trimmed); } catch (_) { continue; }

          if (evt.type === 'status') {
            addThinkingStep(thinking, evt.text);
          } else if (evt.type === 'chunk') {
            if (!gotChunks) { gotChunks = true; settleThinking(thinking); }
            raw += evt.text;
            content.innerHTML = mdParse(raw) + '<span class="caret"></span>';
            scroll();
          } else if (evt.type === 'image') {
            if (!images.includes(evt.url)) { images.push(evt.url); addImageToBubble(bubble, evt.url); }
          } else if (evt.type === 'done') {
            toolsUsed = evt.tools_used || [];
            if (evt.images) images = evt.images;
            if (typeof evt.response === 'string' && evt.response) raw = evt.response;
          } else if (evt.type === 'error') {
            settleThinking(thinking);
            content.innerHTML = mdParse('**Error:** ' + escHtml(evt.error || 'Something went wrong.'));
          }
        }
      }

      settleThinking(thinking);
      content.innerHTML = mdParse(raw || '');
      if (images && images.length) addImageToBubble(bubble, images[0]);
      addToolTags(bubble, toolsUsed);
      addExportBar(bubble, raw || '');

      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: raw });
      if (history.length > 20) history = history.slice(-20);
    } catch (err) {
      settleThinking(thinking);
      content.innerHTML = mdParse('**Network error:** ' + escHtml(err.message));
    }

    scroll();
    sendBtn.disabled = false;
    inputEl.focus();
  }

  // ── Browse & search (Trips / Prices / For Me) ────────────────────────────
  const browseState = {
    trips:  { category: 'flights', items: [], links: {} },
    prices: { category: 'flights', items: [], links: {} }
  };

  function switchTab(tab) {
    document.querySelectorAll('.nav-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
    if (tab === 'globe') setTimeout(initGlobe, 50);
  }

  function switchCategory(page, cat) {
    browseState[page].category = cat;
    document.querySelectorAll('#tab-' + page + ' .subnav-btn').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
    document.querySelectorAll('#tab-' + page + ' .search-form').forEach(f => {
      f.classList.toggle('hidden', f.id !== page + '-form-' + cat);
    });
    browseState[page].items = [];
    browseState[page].links = {};
    document.getElementById(page + '-results').innerHTML = '';
    document.getElementById(page + '-links').innerHTML = '';
    const filterBar = document.getElementById(page + '-filters');
    if (filterBar) filterBar.classList.add('hidden');
  }

  function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }

  function renderBookingLinks(page, links) {
    const wrap = document.getElementById(page + '-links');
    wrap.innerHTML = '';
    Object.keys(links || {}).forEach(label => {
      const a = document.createElement('a');
      a.href = links[label];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Open in ' + label;
      wrap.appendChild(a);
    });
  }

  function priceOf(item) {
    const p = (item.price_usd !== undefined) ? item.price_usd : item.price_per_night_usd;
    return typeof p === 'number' ? p : 0;
  }
  function ratingOf(item) {
    return typeof item.rating === 'number' ? item.rating : 0;
  }

  function renderBrowseCards(page) {
    const state = browseState[page];
    const grid = document.getElementById(page + '-results');
    grid.innerHTML = '';

    if (!state.items.length) {
      grid.innerHTML = '<div class="browse-empty">No results yet — run a search above.</div>';
      return;
    }

    const sortSel = document.getElementById(page + '-sort');
    const maxPriceEl = document.getElementById(page + '-maxprice');
    const stopsSel = document.getElementById(page + '-stops');
    const sort = sortSel ? sortSel.value : 'price-asc';
    const maxPrice = maxPriceEl ? parseInt(maxPriceEl.value, 10) : Infinity;
    const maxStops = (stopsSel && state.category === 'flights') ? parseInt(stopsSel.value, 10) : Infinity;

    let items = state.items.filter(it => {
      if (priceOf(it) > maxPrice) return false;
      if (state.category === 'flights' && typeof it.stops === 'number' && it.stops > maxStops) return false;
      return true;
    });

    items = items.slice().sort((a, b) => {
      if (sort === 'price-asc') return priceOf(a) - priceOf(b);
      if (sort === 'price-desc') return priceOf(b) - priceOf(a);
      if (sort === 'rating-desc') return ratingOf(b) - ratingOf(a);
      return 0;
    });

    if (!items.length) {
      grid.innerHTML = '<div class="browse-empty">No results match your filters — try widening the price range.</div>';
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'result-grid';

    items.forEach(it => {
      const card = document.createElement('div');
      card.className = 'result-card';

      let title = '', price = '', metaParts = [], tags = [];
      const note = it.notes || '';

      if (state.category === 'flights') {
        title = it.airline || 'Flight option';
        price = '$' + Math.round(priceOf(it));
        metaParts = [
          (it.departure_time && it.arrival_time) ? (it.departure_time + ' → ' + it.arrival_time) : '',
          it.duration || '',
          (typeof it.stops === 'number') ? (it.stops === 0 ? 'Nonstop' : (it.stops + ' stop' + (it.stops > 1 ? 's' : ''))) : ''
        ].filter(Boolean);
      } else if (state.category === 'hotels') {
        title = it.name || 'Hotel';
        price = '$' + Math.round(priceOf(it)) + '/night';
        metaParts = [
          it.stars ? (it.stars + '★ stars') : '',
          it.rating ? ('Rating ' + it.rating) : ''
        ].filter(Boolean);
        tags = Array.isArray(it.amenities) ? it.amenities : [];
      } else if (state.category === 'activities') {
        title = it.name || 'Activity';
        price = priceOf(it) > 0 ? ('$' + Math.round(priceOf(it)) + '/person') : 'Free';
        metaParts = [
          it.category || '',
          it.duration || '',
          it.rating ? ('Rating ' + it.rating) : '',
          (typeof it.min_age === 'number' && it.min_age > 0) ? ('Ages ' + it.min_age + '+') : ''
        ].filter(Boolean);
      }

      card.innerHTML =
        '<div class="rc-top"><div class="rc-title">' + escHtml(title) + '</div><div class="rc-price">' + escHtml(price) + '</div></div>' +
        (metaParts.length ? '<div class="rc-meta">' + metaParts.map(m => '<span>' + escHtml(m) + '</span>').join('') + '</div>' : '') +
        (tags.length ? '<div class="rc-tags">' + tags.map(t => '<span class="rc-tag">' + escHtml(t) + '</span>').join('') + '</div>' : '') +
        (note ? '<div class="rc-note">' + escHtml(note) + '</div>' : '') +
        '<div class="rc-tap-hint">Tap for reviews, photos &amp; live prices &rarr;</div>';

      card.addEventListener('click', () => openResultDetail(state.category, it, state.params, { title, price, metaParts, tags, note }));

      wrap.appendChild(card);
    });

    grid.appendChild(wrap);
  }

  // ── Result detail popup: real reviews / photos / live prices via deep links ──
  function buildReviewLinks(category, item, params) {
    const links = [];
    const gsearch = (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q);

    if (category === 'flights') {
      const airline = item.airline || 'flight';
      const route = (params.origin || '') + ' to ' + (params.destination || '');
      links.push({
        label: 'Search this flight on Google Flights',
        sub: 'Live prices, schedules &amp; seat maps',
        url: 'https://www.google.com/travel/flights?q=' + encodeURIComponent(airline + ' flights ' + route + ' ' + (params.departure_date || ''))
      });
      links.push({
        label: 'Compare on Kayak',
        sub: 'Live fares from multiple sites',
        url: 'https://www.kayak.com/flights/' + encodeURIComponent(String(params.origin || '').toLowerCase()) + '-' + encodeURIComponent(String(params.destination || '').toLowerCase()) + '/' + (params.departure_date || '')
      });
      links.push({
        label: 'Reviews of ' + airline,
        sub: 'Real passenger reviews, photos &amp; ratings',
        url: gsearch(airline + ' airline reviews seats photos ' + route)
      });
    } else if (category === 'hotels') {
      const name = item.name || 'hotel';
      const loc = params.location || '';
      links.push({
        label: 'Open ' + name + ' on Booking.com',
        sub: 'Real guest reviews, photos &amp; live prices',
        url: 'https://www.booking.com/searchresults.html?ss=' + encodeURIComponent(name + ', ' + loc) +
             (params.checkin ? '&checkin=' + encodeURIComponent(params.checkin) : '') +
             (params.checkout ? '&checkout=' + encodeURIComponent(params.checkout) : '')
      });
      links.push({
        label: 'See it on Tripadvisor',
        sub: 'Traveller photos, ratings &amp; reviews',
        url: 'https://www.tripadvisor.com/Search?q=' + encodeURIComponent(name + ' ' + loc)
      });
      links.push({
        label: 'Search Google for ' + name,
        sub: 'Photos, reviews &amp; current prices across sites',
        url: gsearch(name + ' ' + loc + ' hotel reviews photos prices')
      });
    } else if (category === 'activities') {
      const name = item.name || 'activity';
      const loc = params.location || '';
      links.push({
        label: 'Find ' + name + ' on Tripadvisor',
        sub: 'Visitor photos, ratings &amp; reviews',
        url: 'https://www.tripadvisor.com/Search?q=' + encodeURIComponent(name + ' ' + loc)
      });
      links.push({
        label: 'Book tickets on Viator',
        sub: 'Availability &amp; live prices',
        url: 'https://www.viator.com/searchResults/all?text=' + encodeURIComponent(name + ' ' + loc)
      });
      links.push({
        label: 'Search Google for ' + name,
        sub: 'Photos, reviews &amp; details',
        url: gsearch(name + ' ' + loc + ' reviews photos tickets')
      });
    }
    return links;
  }

  function openResultDetail(category, item, params, display) {
    const body = document.getElementById('detail-modal-body');
    const links = buildReviewLinks(category, item, params || {});

    body.innerHTML =
      '<div class="detail-head"><div><h2>' + escHtml(display.title) + '</h2></div>' +
        '<div class="detail-price">' + escHtml(display.price) + '</div></div>' +
      (display.metaParts.length ? '<div class="detail-meta">' + display.metaParts.map(m => '<span>' + escHtml(m) + '</span>').join('') + '</div>' : '') +
      (display.tags.length ? '<div class="detail-tags">' + display.tags.map(t => '<span class="rc-tag">' + escHtml(t) + '</span>').join('') + '</div>' : '') +
      (display.note ? '<div class="detail-note">' + escHtml(display.note) + '</div>' : '') +
      '<p class="detail-disclaimer">This card is an AI-generated planning estimate, not a live booking. Use the links below to see the real listing — actual reviews, photos and live prices straight from the source.</p>' +
      '<div class="detail-section-label">See the real thing</div>' +
      '<div class="detail-links">' +
        links.map(l => '<a class="detail-link" href="' + escAttr(l.url) + '" target="_blank" rel="noopener noreferrer">' +
          '<span>' + escHtml(l.label) + '<br><span class="dl-sub">' + l.sub + '</span></span>' +
          '<span class="dl-arrow">&rarr;</span></a>').join('') +
      '</div>' +
      '<div class="detail-section-label">Where it is</div>' +
      '<div id="detail-map" class="detail-map" role="img" aria-label="Map of the destination"></div>';

    document.getElementById('detail-modal').classList.add('open');

    // Geocode the destination and drop a Leaflet map under the listing. Best
    // effort — if geocoding or the map library fails, just hide the map area.
    const place = [ (category === 'hotels' || category === 'activities') ? (item.name || '') : '', params && params.location ? params.location : '' ]
      .filter(Boolean).join(', ');
    initDetailMap(place);
  }

  let detailMap = null;
  async function initDetailMap(place) {
    const el = document.getElementById('detail-map');
    if (!el) return;
    if (typeof L === 'undefined' || !place) { el.style.display = 'none'; return; }
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(place));
      const data = await res.json();
      if (!data || !data.length) { el.style.display = 'none'; return; }
      const lat = parseFloat(data[0].lat), lon = parseFloat(data[0].lon);
      if (detailMap) { try { detailMap.remove(); } catch (_) {} detailMap = null; }
      detailMap = L.map(el, { scrollWheelZoom: false, attributionControl: true }).setView([lat, lon], 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
      }).addTo(detailMap);
      L.marker([lat, lon]).addTo(detailMap).bindPopup(place);
      setTimeout(() => { try { detailMap.invalidateSize(); } catch (_) {} }, 200);
    } catch (_) {
      el.style.display = 'none';
    }
  }

  function closeDetailModal() {
    document.getElementById('detail-modal').classList.remove('open');
    if (detailMap) { try { detailMap.remove(); } catch (_) {} detailMap = null; }
  }
  function maybeCloseDetail(e) { if (e.target === document.getElementById('detail-modal')) closeDetailModal(); }

  function applyBrowseFilters(page) {
    const maxPriceEl = document.getElementById(page + '-maxprice');
    const valEl = document.getElementById(page + '-maxprice-val');
    if (maxPriceEl && valEl) valEl.textContent = maxPriceEl.value;
    renderBrowseCards(page);
  }

  async function submitSearch(evt, page, category) {
    evt.preventDefault();
    const form = evt.target;
    const key = getKey();
    if (!key || !key.startsWith('gsk_')) {
      showToast('Add your free Groq API key first — Settings → paste your key.');
      openSettings();
      return false;
    }

    const params = {};
    new FormData(form).forEach((v, k) => { params[k] = v; });
    if (params.passengers) params.passengers = parseInt(params.passengers, 10) || 1;
    if (params.guests) params.guests = parseInt(params.guests, 10) || 1;
    if (params.rooms) params.rooms = parseInt(params.rooms, 10) || 1;

    const btn = form.querySelector('button[type="submit"]');
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Searching...';

    const grid = document.getElementById(page + '-results');
    grid.innerHTML = '<div class="browse-loading">Searching ' + escHtml(category) + ' for your family...</div>';
    document.getElementById(page + '-links').innerHTML = '';
    const filterBar = document.getElementById(page + '-filters');
    if (filterBar) filterBar.classList.add('hidden');

    try {
      const res = await fetch('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, params, api_key: key, user_profile: profile })
      });
      const data = await res.json();

      if (!res.ok) {
        grid.innerHTML = '<div class="browse-error">' + escHtml(data.error || 'Search failed.') + '</div>';
      } else {
        browseState[page].category = category;
        browseState[page].items = data.items || [];
        browseState[page].links = data.links || {};
        renderBookingLinks(page, browseState[page].links);

        if (filterBar) {
          filterBar.classList.remove('hidden');
          const stopsWrap = document.getElementById(page + '-stops-wrap');
          if (stopsWrap) stopsWrap.classList.toggle('hidden', category !== 'flights');
        }
        renderBrowseCards(page);
      }
    } catch (err) {
      grid.innerHTML = '<div class="browse-error">Network error: ' + escHtml(err.message) + '</div>';
    }

    btn.disabled = false;
    btn.textContent = originalLabel;
    return false;
  }

  // ── Currency converter (Prices tab) ──────────────────────────────────────
  async function convertCurrency() {
    const amount = parseFloat(document.getElementById('price-curr-amount').value) || 0;
    const from = document.getElementById('price-curr-from').value;
    const to = document.getElementById('price-curr-to').value;
    const out = document.getElementById('price-curr-result');
    out.textContent = 'Converting...';
    try {
      const rates = await fetchRates(from);
      const rate = rates[to];
      if (!rate) { out.textContent = 'Could not fetch rate for ' + from + ' → ' + to + '.'; return; }
      const converted = (amount * rate).toFixed(2);
      out.innerHTML = amount + ' ' + from + ' = <span class="pt-rate">' + converted + ' ' + to + '</span> &middot; rate 1 ' + from + ' = ' + rate + ' ' + to;
    } catch (err) {
      out.textContent = 'Currency error: ' + err.message;
    }
  }

  // Rough all-in trip cost: flights (per person) + hotel (per night) +
  // activities & food (per person per day). Totals are shown in USD and,
  // if a different currency is chosen, converted using live rates.
  async function estimateBudget() {
    const num = (id) => parseFloat(document.getElementById(id).value) || 0;
    const people = Math.max(1, num('bud-people'));
    const nights = Math.max(1, num('bud-nights'));
    const days = nights + 1;
    const flights = num('bud-flight') * people;
    const hotel = num('bud-hotel') * nights;
    const activities = num('bud-activities') * people * days;
    const food = num('bud-food') * people * days;
    const totalUsd = flights + hotel + activities + food;
    const out = document.getElementById('price-bud-result');
    const fmt = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

    let line = '<strong>Estimated total: <span class="pt-rate">$' + fmt(totalUsd) + ' USD</span></strong>';
    const cur = document.getElementById('bud-currency').value;
    if (cur && cur !== 'USD') {
      out.innerHTML = line + ' &middot; converting…';
      try {
        const rates = await fetchRates('USD');
        const rate = rates[cur];
        if (rate) line += ' &middot; <span class="pt-rate">' + fmt(totalUsd * rate) + ' ' + cur + '</span>';
      } catch (_) {}
    }
    line += '<div style="margin-top:8px;color:var(--text-muted);font-size:0.8rem;">'
      + 'Flights $' + fmt(flights) + ' &middot; Hotel $' + fmt(hotel)
      + ' &middot; Activities $' + fmt(activities) + ' &middot; Food $' + fmt(food)
      + '<br>For ' + people + ' traveller(s), ' + nights + ' night(s). Rough planning estimate.</div>';
    out.innerHTML = line;
  }

  // ── For Me — personalised recommendations ────────────────────────────────
  async function loadRecommendations() {
    const key = getKey();
    if (!key || !key.startsWith('gsk_')) {
      showToast('Add your free Groq API key first — Settings → paste your key.');
      openSettings();
      return;
    }

    const btn = document.getElementById('forme-btn');
    const grid = document.getElementById('forme-results');
    btn.disabled = true;
    btn.textContent = 'Thinking...';
    grid.innerHTML = '<div class="browse-loading">Curating destinations for your family...</div>';

    try {
      const res = await fetch('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: 'recommendations', params: {}, api_key: key, user_profile: profile })
      });
      const data = await res.json();

      if (!res.ok) {
        grid.innerHTML = '<div class="browse-error">' + escHtml(data.error || 'Could not load recommendations.') + '</div>';
      } else {
        const items = data.items || [];
        if (!items.length) {
          grid.innerHTML = '<div class="browse-empty">No recommendations yet — try again.</div>';
        } else {
          const wrap = document.createElement('div');
          wrap.className = 'result-grid';
          items.forEach((it, i) => {
            const seed = 100 + i;
            const prompt = encodeURIComponent('beautiful travel destination ' + (it.destination || '') + ' family vacation photorealistic golden hour landscape');
            const imgUrl = 'https://image.pollinations.ai/prompt/' + prompt + '?width=500&height=300&nologo=true&seed=' + seed;

            const card = document.createElement('div');
            card.className = 'reco-card';
            card.innerHTML =
              '<img src="' + imgUrl + '" alt="' + escAttr(it.destination || '') + '" data-dest="' + escAttr(it.destination || 'Destination photo unavailable') + '" loading="lazy" onerror="imgFallback(this, this.dataset.dest)" />' +
              '<div class="reco-body">' +
                '<div class="reco-dest">' + escHtml(it.destination || '') + '</div>' +
                '<div class="reco-why">' + escHtml(it.why || '') + '</div>' +
                '<div class="reco-meta">' +
                  (it.best_time ? '<span>Best time: ' + escHtml(it.best_time) + '</span>' : '') +
                  (it.est_budget_usd ? '<span>~$' + Math.round(it.est_budget_usd) + ' / week (whole family)</span>' : '') +
                  (it.highlight ? '<span>' + escHtml(it.highlight) + '</span>' : '') +
                '</div>' +
              '</div>';

            const planBtn = document.createElement('button');
            planBtn.className = 'reco-plan';
            planBtn.textContent = 'Plan this trip';
            planBtn.addEventListener('click', () => planThisTrip(it.destination || ''));
            card.querySelector('.reco-body').appendChild(planBtn);

            wrap.appendChild(card);
          });
          grid.innerHTML = '';
          grid.appendChild(wrap);
        }
      }
    } catch (err) {
      grid.innerHTML = '<div class="browse-error">Network error: ' + escHtml(err.message) + '</div>';
    }

    btn.disabled = false;
    btn.textContent = 'Get personalised picks';
  }

  function planThisTrip(destination) {
    switchTab('chat');
    inputEl.value = 'Plan a family trip to ' + destination;
    resize();
    inputEl.focus();
  }

  // ── Init ────────────────────────────────────────────────────────────────
  (function init() {
    initHeroSlideshow();
    initSellSection();
    initAirportList();
    if (profile) {
      initApp();
      showPage('page-app');
    } else {
      showPage('page-login');
    }
    updateKeyStatus();
  })();
<\/script>
</body>
</html>`;

// ─── PWA assets (manifest, service worker, icon) ──────────────────────────────

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#2b2924"/>
  <g transform="translate(256,256) scale(13.5) translate(-12,-12)" fill="none" stroke="#c97b5f" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">
    <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
  </g>
</svg>`;

const MANIFEST = {
  name: 'FamilyTripAI',
  short_name: 'FamilyTrip',
  description: 'AI family-travel planner — flights, hotels, weather, activities and a day-by-day itinerary in one chat.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#2b2924',
  theme_color: '#2b2924',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
  ]
};

// Offline app shell: cache the shell + CDN libs on install, serve the cached
// page when a navigation fails (offline). API calls (/chat, /search) are always
// network-only — never cache POST or dynamic responses.
const SERVICE_WORKER = `
const CACHE = 'familytrip-v1';
const SHELL = [
  '/',
  'https://cdn.jsdelivr.net/npm/marked/marked.min.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // never cache /chat or /search
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res && res.ok && (req.url.startsWith(self.location.origin) || req.url.includes('cdn.jsdelivr.net'))) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => hit)));
});
`;

// ─── CORS headers ─────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // GET / → serve HTML
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      return new Response(HTML, {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    // PWA: web app manifest
    if (method === 'GET' && url.pathname === '/manifest.webmanifest') {
      return new Response(JSON.stringify(MANIFEST), {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=86400' }
      });
    }

    // PWA: service worker (offline app shell)
    if (method === 'GET' && url.pathname === '/sw.js') {
      return new Response(SERVICE_WORKER, {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'text/javascript;charset=UTF-8', 'Cache-Control': 'no-cache' }
      });
    }

    // PWA / favicon: app icon
    if (method === 'GET' && (url.pathname === '/icon.svg' || url.pathname === '/favicon.ico')) {
      return new Response(ICON_SVG, {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=604800' }
      });
    }

    // POST /chat → run agent
    if (method === 'POST' && url.pathname === '/chat') {
      let body;
      try {
        body = await request.json();
      } catch (_) {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
          status: 400,
          headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }

      const { message, history = [], api_key, user_profile } = body;

      if (!api_key || !api_key.startsWith('gsk_')) {
        return new Response(
          JSON.stringify({ error: 'Invalid or missing Groq API key. Get a free key at console.groq.com and paste it in settings.' }),
          { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }

      if (!message || typeof message !== 'string' || !message.trim()) {
        return new Response(
          JSON.stringify({ error: 'Message is required.' }),
          { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }

      // Stream the agent's progress (tool "thoughts" + the final answer,
      // word by word) to the client as newline-delimited JSON so the chat
      // can render it ChatGPT-style instead of waiting on one big response.
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const emit = async (event) => {
        try { await writer.write(encoder.encode(JSON.stringify(event) + '\n')); } catch (_) {}
      };

      const run = (async () => {
        try {
          const result = await runAgent(message.trim(), history, api_key, user_profile || null, emit);
          await emit({ type: 'done', tools_used: result.tools_used, images: result.images, response: result.response });
        } catch (err) {
          console.error('Agent error:', err);
          await emit({ type: 'error', error: err.message || 'Internal server error' });
        } finally {
          try { await writer.close(); } catch (_) {}
        }
      })();

      if (ctx && ctx.waitUntil) ctx.waitUntil(run);

      return new Response(readable, {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' }
      });
    }

    // POST /search → structured browsing data for Trips / Prices / For Me
    if (method === 'POST' && url.pathname === '/search') {
      let body;
      try {
        body = await request.json();
      } catch (_) {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
          status: 400,
          headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }

      const { category, params = {}, api_key, user_profile } = body;
      const validCategories = ['flights', 'hotels', 'activities', 'recommendations'];

      if (!api_key || !api_key.startsWith('gsk_')) {
        return new Response(
          JSON.stringify({ error: 'Invalid or missing Groq API key. Get a free key at console.groq.com and paste it in settings.' }),
          { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }

      if (!validCategories.includes(category)) {
        return new Response(
          JSON.stringify({ error: `Invalid category. Expected one of: ${validCategories.join(', ')}` }),
          { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }

      try {
        const result = await runSearch(category, params, api_key, user_profile || null);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        console.error('Search error:', err);
        return new Response(
          JSON.stringify({ error: err.message || 'Internal server error' }),
          { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }
    }

    // 404 for everything else
    return new Response('Not found', {
      status: 404,
      headers: { ...CORS, 'Content-Type': 'text/plain' }
    });
  }
};

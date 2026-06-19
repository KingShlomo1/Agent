import json
from datetime import date
from groq import Groq
from tools import TOOL_MAP

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for current information about any topic",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "max_results": {"type": "integer", "default": 5}
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get weather forecast for a travel destination",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string", "description": "City or destination name"},
                    "days": {"type": "integer", "description": "Forecast days (max 16)", "default": 7}
                },
                "required": ["location"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "find_restaurants",
            "description": "Find family-friendly restaurants at a destination",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string"},
                    "cuisine": {"type": "string", "description": "Cuisine type (optional)", "default": ""},
                    "family_friendly": {"type": "boolean", "default": True}
                },
                "required": ["location"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_flights",
            "description": "Search for flights and provide booking links",
            "parameters": {
                "type": "object",
                "properties": {
                    "origin": {"type": "string", "description": "Departure city or airport"},
                    "destination": {"type": "string", "description": "Destination city or airport"},
                    "departure_date": {"type": "string", "description": "Date in YYYY-MM-DD format"},
                    "return_date": {"type": "string", "description": "Return date YYYY-MM-DD (for round trips)", "default": ""},
                    "passengers": {"type": "integer", "description": "Total number of passengers", "default": 1}
                },
                "required": ["origin", "destination", "departure_date"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_hotels",
            "description": "Search for family hotels and provide booking links",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string"},
                    "checkin": {"type": "string", "description": "Check-in date YYYY-MM-DD"},
                    "checkout": {"type": "string", "description": "Check-out date YYYY-MM-DD"},
                    "guests": {"type": "integer", "default": 2},
                    "rooms": {"type": "integer", "default": 1}
                },
                "required": ["location", "checkin", "checkout"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "find_activities",
            "description": "Find activities and attractions for families at a destination",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string"},
                    "activity_type": {"type": "string", "description": "Type: family, adventure, cultural, beach, theme park, etc.", "default": "family"},
                    "num_results": {"type": "integer", "default": 6}
                },
                "required": ["location"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "generate_destination_image",
            "description": "Generate a beautiful image of a travel destination",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string", "description": "Destination name to visualize"}
                },
                "required": ["location"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_travel_tips",
            "description": "Get practical travel tips, visa info, safety advice, and packing lists for families",
            "parameters": {
                "type": "object",
                "properties": {
                    "destination": {"type": "string"},
                    "month": {"type": "string", "description": "Month of travel (optional)", "default": ""}
                },
                "required": ["destination"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "currency_info",
            "description": "Get live currency exchange rates",
            "parameters": {
                "type": "object",
                "properties": {
                    "from_currency": {"type": "string", "description": "Source currency code, e.g. USD"},
                    "to_currency": {"type": "string", "description": "Target currency code, e.g. EUR"}
                },
                "required": ["from_currency", "to_currency"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "find_local_transport",
            "description": "Find local transportation options at the destination",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string"}
                },
                "required": ["location"]
            }
        }
    }
]

# Kept in parity with the system prompt in worker.js (the deployed Cloudflare
# Worker). When you change one, change the other.
SYSTEM_PROMPT = """You are FamilyTripAI, an expert family travel planning assistant. You help families plan complete trips with practical, detailed advice tailored for travelling with children.

When planning a trip, always:
1. Generate a destination image first
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
Today's date: """ + date.today().isoformat()


def run_agent(messages: list, api_key: str) -> tuple:
    client = Groq(api_key=api_key)
    full_messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages
    tools_used = []

    while True:
        response = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=full_messages,
            tools=TOOLS,
            tool_choice="auto",
            max_tokens=4096,
        )

        msg = response.choices[0].message

        if not msg.tool_calls:
            return msg.content, tools_used

        tool_calls_payload = [
            {
                "id": tc.id,
                "type": "function",
                "function": {"name": tc.function.name, "arguments": tc.function.arguments}
            }
            for tc in msg.tool_calls
        ]
        full_messages.append({
            "role": "assistant",
            "content": msg.content or "",
            "tool_calls": tool_calls_payload
        })

        for tc in msg.tool_calls:
            fn_name = tc.function.name
            try:
                args = json.loads(tc.function.arguments)
            except Exception:
                args = {}

            tools_used.append({"tool": fn_name, "args": args})

            fn = TOOL_MAP.get(fn_name)
            if fn:
                try:
                    result = fn(**args)
                except Exception as e:
                    result = f"Tool error: {e}"
            else:
                result = f"Unknown tool: {fn_name}"

            if isinstance(result, dict):
                result = json.dumps(result)

            full_messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": str(result)
            })

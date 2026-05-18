import json
import os
from groq import Groq
from tools import TOOL_MAP

client = Groq(api_key=os.environ["GROQ_API_KEY"])

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
            "description": "Get practical travel tips, visa info, safety advice, packing lists for families",
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

SYSTEM_PROMPT = """You are FamilyTripAI ✈️, the ultimate family travel planning assistant. You help families plan incredible trips with thorough, practical, kid-friendly advice.

Your capabilities:
- 🔍 Search the web for real-time travel info
- 🌤️ Check weather forecasts for any destination
- ✈️ Search flights with direct booking links
- 🏨 Find family hotels with booking links
- 🍽️ Recommend family-friendly restaurants
- 🎡 Find activities for kids and adults
- 🖼️ Generate beautiful destination images
- 💡 Give practical travel tips and visa info
- 💱 Check live currency exchange rates
- 🚌 Find local transport options

When a user asks to plan a trip:
1. Generate a destination image first to set the mood
2. Search flights and hotels with booking links
3. Check the weather for their travel dates
4. Recommend top activities for families
5. Suggest family-friendly restaurants
6. Share practical travel tips (visa, safety, packing)
7. Check currency if travelling internationally
8. Create a day-by-day itinerary

Always think about kids' needs: safety, entertainment, meal options, rest times.
Format responses with clear sections, headers, and emojis. Be enthusiastic and helpful!
Today's date: 2026-05-18"""


def run_agent(messages: list) -> tuple:
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

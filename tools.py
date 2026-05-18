import requests
import json
from urllib.parse import quote

def web_search(query: str, max_results: int = 5) -> str:
    try:
        from duckduckgo_search import DDGS
        results = list(DDGS().text(query, max_results=max_results))
        if not results:
            return "No results found."
        output = []
        for r in results:
            output.append(f"**{r['title']}**\n{r['body']}\n{r['href']}")
        return "\n\n".join(output)
    except Exception as e:
        return f"Search error: {e}"


def get_weather(location: str, days: int = 7) -> str:
    try:
        headers = {"User-Agent": "FamilyTripAI/1.0"}
        geo_url = f"https://nominatim.openstreetmap.org/search?q={quote(location)}&format=json&limit=1"
        geo = requests.get(geo_url, headers=headers, timeout=10).json()
        if not geo:
            return f"Location '{location}' not found."
        lat, lon = geo[0]["lat"], geo[0]["lon"]
        display_name = geo[0].get("display_name", location)

        forecast_days = min(int(days), 16)
        weather_url = (
            f"https://api.open-meteo.com/v1/forecast?"
            f"latitude={lat}&longitude={lon}"
            f"&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_mean,weathercode"
            f"&timezone=auto&forecast_days={forecast_days}"
        )
        data = requests.get(weather_url, timeout=10).json()
        daily = data["daily"]

        wmo = {
            0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
            45: "Foggy", 48: "Icy fog", 51: "Light drizzle", 53: "Moderate drizzle",
            55: "Heavy drizzle", 61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
            71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
            80: "Slight showers", 81: "Moderate showers", 82: "Heavy showers",
            95: "Thunderstorm", 99: "Heavy thunderstorm with hail"
        }

        lines = [f"Weather forecast for {display_name} ({forecast_days} days):"]
        for i in range(len(daily["time"])):
            code = daily["weathercode"][i]
            desc = wmo.get(code, f"Code {code}")
            rain = daily["precipitation_probability_mean"][i]
            hi = daily["temperature_2m_max"][i]
            lo = daily["temperature_2m_min"][i]
            lines.append(f"{daily['time'][i]}: {desc} | High {hi}°C / Low {lo}°C | Rain chance {rain}%")
        return "\n".join(lines)
    except Exception as e:
        return f"Weather error: {e}"


def find_restaurants(location: str, cuisine: str = "", family_friendly: bool = True) -> str:
    tag = "family friendly" if family_friendly else "best"
    query = f"{tag} {cuisine} restaurants {location} kids children menu"
    return web_search(query, max_results=6)


def search_flights(origin: str, destination: str, departure_date: str,
                   return_date: str = "", passengers: int = 1) -> str:
    gf_base = "https://www.google.com/travel/flights"
    google_url = f"{gf_base}?q=flights+from+{quote(origin)}+to+{quote(destination)}+{departure_date}"
    skyscanner_url = (
        f"https://www.skyscanner.com/transport/flights/"
        f"{quote(origin.lower())}/{quote(destination.lower())}/{departure_date.replace('-','')}"
    )

    query = f"cheap flights {origin} to {destination} {departure_date}"
    if return_date:
        query += f" return {return_date}"
    query += f" {passengers} passengers family"
    results = web_search(query, max_results=4)

    header = (
        f"**Flights: {origin} → {destination}**\n"
        f"Departure: {departure_date}"
        + (f" | Return: {return_date}" if return_date else "")
        + f" | Passengers: {passengers}\n\n"
        f"Book here:\n"
        f"- Google Flights: {google_url}\n"
        f"- Skyscanner: {skyscanner_url}\n\n"
        f"Recent search results:\n"
    )
    return header + results


def search_hotels(location: str, checkin: str, checkout: str,
                  guests: int = 2, rooms: int = 1) -> str:
    booking_url = (
        f"https://www.booking.com/searchresults.html?ss={quote(location)}"
        f"&checkin={checkin}&checkout={checkout}"
        f"&group_adults={guests}&no_rooms={rooms}"
    )
    hotels_url = (
        f"https://www.hotels.com/search.do?q-destination={quote(location)}"
        f"&q-check-in={checkin}&q-check-out={checkout}&q-rooms={rooms}&q-room-0-adults={guests}"
    )

    query = f"best family hotels {location} {checkin} kids amenities pool"
    results = web_search(query, max_results=4)

    header = (
        f"**Hotels in {location}**\n"
        f"Check-in: {checkin} | Check-out: {checkout} | Guests: {guests} | Rooms: {rooms}\n\n"
        f"Book here:\n"
        f"- Booking.com: {booking_url}\n"
        f"- Hotels.com: {hotels_url}\n\n"
        f"Recent search results:\n"
    )
    return header + results


def find_activities(location: str, activity_type: str = "family", num_results: int = 6) -> str:
    query = f"best {activity_type} activities things to do {location} kids children"
    return web_search(query, max_results=num_results)


def get_travel_tips(destination: str, month: str = "") -> str:
    query = f"family travel tips {destination} {month} visa requirements safety kids packing"
    return web_search(query, max_results=5)


def currency_info(from_currency: str, to_currency: str) -> str:
    try:
        url = f"https://api.frankfurter.app/latest?from={from_currency.upper()}&to={to_currency.upper()}"
        data = requests.get(url, timeout=10).json()
        rate = data["rates"][to_currency.upper()]
        return f"1 {from_currency.upper()} = {rate} {to_currency.upper()} (European Central Bank)"
    except Exception as e:
        return f"Currency error: {e}"


def generate_destination_image(location: str) -> dict:
    prompt = quote(f"stunning travel destination {location} beautiful landscape family vacation photorealistic golden hour")
    url = f"https://image.pollinations.ai/prompt/{prompt}?width=900&height=450&nologo=true&seed=42"
    return {"image_url": url, "location": location, "type": "destination_image"}


def find_local_transport(location: str) -> str:
    query = f"getting around {location} public transport taxi uber family tips"
    return web_search(query, max_results=4)


TOOL_MAP = {
    "web_search": web_search,
    "get_weather": get_weather,
    "find_restaurants": find_restaurants,
    "search_flights": search_flights,
    "search_hotels": search_hotels,
    "find_activities": find_activities,
    "get_travel_tips": get_travel_tips,
    "currency_info": currency_info,
    "generate_destination_image": generate_destination_image,
    "find_local_transport": find_local_transport,
}

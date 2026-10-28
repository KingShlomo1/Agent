import re
import os
from fastapi import FastAPI, HTTPException, Header
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

from agent import run_agent

app = FastAPI(title="FamilyTripAI")
app.mount("/static", StaticFiles(directory="static"), name="static")

IMAGE_PATTERN = re.compile(r'https://image\.pollinations\.ai/prompt/[^\s\)\]"\']+')
CLIPROXY_BASE_URL = os.environ.get("CLIPROXY_BASE_URL", "").strip()


class ChatRequest(BaseModel):
    message: str
    history: list = []
    api_key: Optional[str] = None


class ChatResponse(BaseModel):
    response: str
    tools_used: list
    images: list


@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.get("/config")
async def get_config():
    # Tells the frontend whether it needs to collect a Groq key from the user,
    # or whether the server already has a working AI backend (CLIProxyAPI) configured.
    return {"requires_key": not bool(CLIPROXY_BASE_URL)}


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    # Key can come from request body or environment; not needed when CLIProxyAPI is configured.
    api_key = req.api_key or os.environ.get("GROQ_API_KEY", "")
    if not CLIPROXY_BASE_URL and (not api_key or not api_key.startswith("gsk_")):
        raise HTTPException(
            status_code=400,
            detail="Invalid or missing Groq API key. Get a free key at console.groq.com and paste it in the settings panel."
        )

    try:
        messages = req.history + [{"role": "user", "content": req.message}]
        response, tools_used = run_agent(messages, api_key)

        images = IMAGE_PATTERN.findall(response or "")

        for t in tools_used:
            if t["tool"] == "generate_destination_image":
                from tools import generate_destination_image
                result = generate_destination_image(**t["args"])
                if result.get("image_url") and result["image_url"] not in images:
                    images.append(result["image_url"])

        return ChatResponse(response=response or "", tools_used=tools_used, images=images)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)

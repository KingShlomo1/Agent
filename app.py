import re
import os
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

if not os.environ.get("GROQ_API_KEY"):
    raise RuntimeError("GROQ_API_KEY not set. Copy .env.example to .env and add your key.")

from agent import run_agent

app = FastAPI(title="FamilyTripAI")
app.mount("/static", StaticFiles(directory="static"), name="static")

IMAGE_PATTERN = re.compile(r'https://image\.pollinations\.ai/prompt/[^\s\)\]"\']+')


class ChatRequest(BaseModel):
    message: str
    history: list = []


class ChatResponse(BaseModel):
    response: str
    tools_used: list
    images: list


@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    try:
        messages = req.history + [{"role": "user", "content": req.message}]
        response, tools_used = run_agent(messages)

        # Pull out any image URLs the agent produced
        images = IMAGE_PATTERN.findall(response or "")

        # Also grab images returned by generate_destination_image tool
        for t in tools_used:
            if t["tool"] == "generate_destination_image":
                from tools import generate_destination_image
                result = generate_destination_image(**t["args"])
                if result.get("image_url") and result["image_url"] not in images:
                    images.append(result["image_url"])

        return ChatResponse(response=response or "", tools_used=tools_used, images=images)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)

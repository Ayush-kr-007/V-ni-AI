import asyncio
import json
import logging
import os
from dotenv import load_dotenv
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from tools import tools_list, tool_mapping
from gemini_live import GeminiLive
from twilio_handler import TwilioHandler

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MODEL = os.getenv("MODEL", "gemini-2.5-flash")

TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
TWILIO_APP_HOST = os.getenv("TWILIO_APP_HOST")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="frontend"), name="static")

@app.get("/")
async def root():
    return FileResponse("frontend/index.html")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for pure web audio client loop."""
    await websocket.accept()
    logger.info("WebSocket connection accepted")

    audio_input_queue = asyncio.Queue()
    text_input_queue = asyncio.Queue()

    async def audio_output_callback(data):
        try:
            await websocket.send_bytes(data)
        except Exception as e:
            logger.error(f"Failed to send audio bytes to client: {e}")
            raise

    async def audio_interrupt_callback():
        pass

    gemini_client = GeminiLive(
        api_key=GEMINI_API_KEY, 
        model=MODEL, 
        input_sample_rate=16000,
        tools=tools_list,
        tool_mapping=tool_mapping
    )

    async def receive_from_client():
        try:
            while True:
                message = await websocket.receive()
                if "bytes" in message and message["bytes"]:
                    await audio_input_queue.put(message["bytes"])
                elif "text" in message and message["text"]:
                    await text_input_queue.put(message["text"])
        except WebSocketDisconnect:
            logger.info("WebSocket disconnected normally from client.")
        except Exception as e:
            logger.error(f"Error receiving from client: {e}")
        finally:
            # Force the other task to exit if the client disconnects
            raise WebSocketDisconnect()

    async def run_session():
        try:
            async for event in gemini_client.start_session(
                audio_input_queue=audio_input_queue,
                text_input_queue=text_input_queue,
                audio_output_callback=audio_output_callback,
                audio_interrupt_callback=audio_interrupt_callback,
            ):
                if event:
                    try:
                        await websocket.send_json(event)
                    except Exception as e:
                        logger.error(f"Failed to send JSON event: {e}")
                        break
        except Exception as e:
            import traceback
            logger.error(f"Error in Gemini session loop: {e}\n{traceback.format_exc()}")

    # Gather both tasks together so that if either fails/exits, they both stop cleanly
    receive_task = asyncio.create_task(receive_from_client())
    session_task = asyncio.create_task(run_session())

    try:
        # Wait until one of the loops drops out
        done, pending = await asyncio.wait(
            [receive_task, session_task],
            return_when=asyncio.FIRST_COMPLETED
        )
    finally:
        # Cleanly abort everything remaining
        receive_task.cancel()
        session_task.cancel()
        await asyncio.gather(receive_task, session_task, return_exceptions=True)
        
        try:
            await websocket.close()
        except Exception:
            pass
        logger.info("Cleaned up websocket connection loops entirely.")

# ─── Twilio Webhooks ─────────────────────────────────────────────────────────

@app.post("/twilio/inbound")
async def twilio_inbound():
    host = TWILIO_APP_HOST or "localhost:8000"
    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Connecting to Gemini Live Travel Assistant.</Say>
    <Connect>
        <Stream url="wss://{host}/twilio/stream" />
    </Connect>
</Response>"""
    return Response(content=twiml, media_type="application/xml")

@app.post("/twilio/outbound")
async def twilio_outbound(
    to_number: str = Query(..., description="Destination phone number (E.164 format)"),
    from_number: str = Query(..., description="Your Twilio phone number (E.164 format)"),
):
    if not TWILIO_ACCOUNT_SID or not TWILIO_AUTH_TOKEN or not TWILIO_APP_HOST:
        return {"error": "Twilio parameters missing from environment variables."}

    from twilio.rest import Client as TwilioClient
    client = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    twiml = f"""<Response>
    <Say>Connecting to Gemini Live Travel Assistant.</Say>
    <Connect>
        <Stream url="wss://{TWILIO_APP_HOST}/twilio/stream" />
    </Connect>
</Response>"""

    call = client.calls.create(to=to_number, from_=from_number, twiml=twiml)
    logger.info(f"Outbound call initiated: {call.sid}")
    return {"callSid": call.sid, "status": call.status}

@app.websocket("/twilio/stream")
async def twilio_stream(websocket: WebSocket):
    await websocket.accept()
    logger.info("Twilio media stream WebSocket connected")
    handler = TwilioHandler(gemini_api_key=GEMINI_API_KEY, model=MODEL)
    try:
        await handler.handle_media_stream(websocket)
    except Exception as e:
        logger.error(f"Twilio stream error: {e}", exc_info=True)
    finally:
        try:
            await websocket.close()
        except Exception:
            pass

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8001))
    uvicorn.run(app, host="0.0.0.0", port=port)
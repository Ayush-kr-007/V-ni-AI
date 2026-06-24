import asyncio
import json
import logging
import os
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from tools import tools_list, tool_mapping
from gemini_live import GeminiLive

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MODEL = os.getenv("MODEL", "gemini-2.5-flash")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Route the premium frontend static elements
app.mount("/static", StaticFiles(directory="frontend"), name="static")

@app.get("/")
async def root():
    return FileResponse("frontend/index.html")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint driving the premium Vāni AI voice loop."""
    await websocket.accept()
    logger.info("Premium Vāni AI WebSocket session authenticated.")

    audio_input_queue = asyncio.Queue()
    text_input_queue = asyncio.Queue()

    # Outbound Audio Byte Pipeline
    async def audio_output_callback(data):
        try:
            await websocket.send_bytes(data)
        except Exception as e:
            logger.error(f"Failed to transmit downstream audio PCM frame: {e}")
            raise

    # Triggered automatically when user interrupts Gemini speaking
    async def audio_interrupt_callback():
        try:
            await websocket.send_json({"type": "interrupted"})
        except Exception as e:
            logger.error(f"Failed to broadcast interrupt event: {e}")

    gemini_client = GeminiLive(
        api_key=GEMINI_API_KEY, 
        model=MODEL, 
        input_sample_rate=16000, # Matches frontend AudioContext capture config
        tools=tools_list,
        tool_mapping=tool_mapping
    )

    async def receive_from_client():
        try:
            while True:
                message = await websocket.receive()
                # Sort incoming data packets accurately
                if "bytes" in message and message["bytes"]:
                    await audio_input_queue.put(message["bytes"])
                elif "text" in message and message["text"]:
                    # Safely extracts text frames sent via text-fallback input box
                    await text_input_queue.put(message["text"])
        except WebSocketDisconnect:
            logger.info("Vāni AI client closed connection node normally.")
        except Exception as e:
            logger.error(f"Error caught inside incoming client read loop: {e}")
        finally:
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
                        # Catch the tool call execution blocks natively 
                        # and match them against parameters required by the frontend layout
                        if event.get("type") == "tool_call":
                            # Intercept function argument shapes to safely update UI cards
                            args = event.get("args", {})
                            payload = {
                                "type": "tool_call",
                                "name": event.get("name"),
                                "args": {
                                    "destination": args.get("destination", args.get("location", "Processing...")),
                                    "dates": args.get("dates", args.get("timeframe", "Flexible")),
                                    "budget": args.get("budget", "Flexible Allocation")
                                }
                            }
                            await websocket.send_json(payload)
                        else:
                            # Forward standard turn completions, transcript logs, and text structures
                            await websocket.send_json(event)
                    except Exception as e:
                        logger.error(f"Failed parsing/sending JSON payload matrix downstream: {e}")
                        break
        except Exception as e:
            import traceback
            logger.error(f"Critical execution error inside Gemini driver runner: {e}\n{traceback.format_exc()}")

    # Orchestrate safe multi-task async mapping
    receive_task = asyncio.create_task(receive_from_client())
    session_task = asyncio.create_task(run_session())

    try:
        done, pending = await asyncio.wait(
            [receive_task, session_task],
            return_when=asyncio.FIRST_COMPLETED
        )
    finally:
        receive_task.cancel()
        session_task.cancel()
        await asyncio.gather(receive_task, session_task, return_exceptions=True)
        
        try:
            await websocket.close()
        except Exception:
            pass
        logger.info("Cleaned up premium Vāni AI tracking states.")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
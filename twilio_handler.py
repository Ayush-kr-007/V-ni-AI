import asyncio
import base64
import json
import logging
import audioop
from google.genai import types
from gemini_live import GeminiLive
from tools import tools_list, tool_mapping

logger = logging.getLogger(__name__)

class TwilioHandler:
    def __init__(self, gemini_api_key, model):
        self.gemini_client = GeminiLive(
            api_key=gemini_api_key,
            model=model,
            input_sample_rate=16000,
            tools=tools_list,
            tool_mapping=tool_mapping
        )
        self.stream_sid = None
        logger.info(f"TwilioHandler initialized with model={model}")

    async def handle_media_stream(self, websocket):
        """Processes the Twilio Media Stream."""
        audio_input_queue = asyncio.Queue()
        text_input_queue = asyncio.Queue()

        MULAW_FRAME_SIZE = 160  # 20ms at 8kHz, 1 byte per sample (mulaw)
        output_buffer = bytearray()

        async def send_buffered_audio(ws, stream_sid):
            nonlocal output_buffer
            while len(output_buffer) >= MULAW_FRAME_SIZE:
                frame = bytes(output_buffer[:MULAW_FRAME_SIZE])
                del output_buffer[:MULAW_FRAME_SIZE]
                payload = base64.b64encode(frame).decode("utf-8")
                message = {
                    "event": "media",
                    "streamSid": stream_sid,
                    "media": {"payload": payload},
                }
                await ws.send_text(json.dumps(message))

        async def audio_output_callback(data):
            nonlocal output_buffer
            if not self.stream_sid:
                return
            try:
                # 24kHz 16-bit PCM -> 16kHz -> 8kHz
                intermediate, _ = audioop.ratecv(data, 2, 1, 24000, 16000, None)
                resampled_data, _ = audioop.ratecv(intermediate, 2, 1, 16000, 8000, None)
                mulaw_data = audioop.lin2ulaw(resampled_data, 2)

                output_buffer.extend(mulaw_data)
                await send_buffered_audio(websocket, self.stream_sid)
            except Exception as e:
                logger.error(f"Error sending audio to Twilio: {e}", exc_info=True)

        async def audio_interrupt_callback():
            nonlocal output_buffer
            output_buffer.clear()
            if self.stream_sid:
                await websocket.send_text(json.dumps({
                    "event": "clear",
                    "streamSid": self.stream_sid
                }))

        logger.info("Starting Gemini session task for Twilio call...")
        gemini_task = asyncio.create_task(self._run_gemini_session(
            audio_input_queue, text_input_queue, 
            audio_output_callback, audio_interrupt_callback
        ))

        try:
            async for message in websocket.iter_text():
                data = json.loads(message)
                event = data.get("event")

                if event == "start":
                    self.stream_sid = data["start"]["streamSid"]
                    logger.info(f"Twilio Stream started — streamSid={self.stream_sid}")
                    await text_input_queue.put("Greet the caller warmly and ask how you can help them plan their trip.")
                
                elif event == "media":
                    payload = data["media"]["payload"]
                    mulaw_data = base64.b64decode(payload)
                    pcm_data = audioop.ulaw2lin(mulaw_data, 2)
                    resampled_data, _ = audioop.ratecv(pcm_data, 2, 1, 8000, 16000, None)
                    await audio_input_queue.put(resampled_data)
                
                elif event == "stop":
                    logger.info(f"Twilio Stream stopped: {self.stream_sid}")
                    break
        except Exception as e:
            logger.error(f"Error in Twilio media stream: {e}", exc_info=True)
        finally:
            if gemini_task.done() and not gemini_task.cancelled():
                exc = gemini_task.exception()
                if exc:
                    logger.error(f"Gemini task failed with exception: {exc}", exc_info=exc)
            gemini_task.cancel()
            logger.info("Twilio handler finished — cleaning up")

    async def _run_gemini_session(self, audio_input_queue, text_input_queue, output_callback, interrupt_callback):
        try:
            async for event in self.gemini_client.start_session(
                audio_input_queue=audio_input_queue,
                text_input_queue=text_input_queue,
                audio_output_callback=output_callback,
                audio_interrupt_callback=interrupt_callback,
            ):
                if event and isinstance(event, dict) and event.get("type") == "error":
                    logger.error(f"Gemini returned error event: {event}")
        except asyncio.CancelledError:
            logger.info("Gemini session cancelled")
        except Exception as e:
            logger.error(f"Error in Gemini session (Twilio): {e}", exc_info=True)
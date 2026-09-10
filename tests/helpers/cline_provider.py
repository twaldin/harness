"""Finite loopback OpenAI-compatible peer for the real optional Cline SDK.

All inputs, credentials and replies are synthetic. Closing stdin stops this
owned peer; the independent deadline also bounds a caller that disappears.
"""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler
import json
from pathlib import Path
from socketserver import ThreadingTCPServer
import sys
import threading

workdir = Path(sys.argv[1])
scenario = sys.argv[2]


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        self.connection.settimeout(5)
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with (workdir / "provider-requests.jsonl").open("a") as log:
            log.write(json.dumps(request) + "\n")
        if scenario == "provider-error":
            data = json.dumps({"error": {"message": "synthetic provider rejection", "type": "invalid_request_error"}}).encode()
            self.send_response(400)
            self.send_header("content-type", "application/json")
        else:
            tool = scenario in {"reject", "interrupt", "close", "worker-loss", "command-error"} and request["messages"][-1]["role"] != "tool"
            command = "printf synthetic-command-error; exit 7" if scenario == "command-error" else "printf owned-tool-running; sleep 3; printf survived > survived"
            delta = {
                "role": "assistant",
                "tool_calls": [{"index": 0, "id": "synthetic-tool", "type": "function", "function": {
                    "name": "run_commands", "arguments": json.dumps({"commands": [command]}),
                }}],
            } if tool else {"role": "assistant", "content": "synthetic native reply"}

            def chunk(value, reason=None):
                return {"id": "synthetic", "object": "chat.completion.chunk", "created": 1, "model": "synthetic", "choices": [{"index": 0, "delta": value, "finish_reason": reason}]}

            frames = [chunk(delta), {**chunk({}, "tool_calls" if tool else "stop"), "usage": {"prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14}}]
            data = ("".join("data: " + json.dumps(frame) + "\n\n" for frame in frames) + "data: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


# HTTPServer performs reverse DNS during bind; this loopback peer needs none.
server = ThreadingTCPServer(("127.0.0.1", 0), Provider)
server.daemon_threads = True
finished = threading.Event()


def stop_on_eof():
    sys.stdin.buffer.read()
    finished.set()


reader = threading.Thread(target=stop_on_eof, daemon=True)
serving = threading.Thread(target=server.serve_forever)
reader.start()
serving.start()
print(json.dumps({"endpoint": f"http://127.0.0.1:{server.server_address[1]}/v1"}), flush=True)
try:
    finished.wait(60)
finally:
    server.shutdown()
    server.server_close()
    serving.join()

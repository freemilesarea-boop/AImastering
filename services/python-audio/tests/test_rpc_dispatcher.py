"""
Unit tests for the JSON-RPC dispatcher (app/main.py).

Tests the protocol layer (method routing, error codes, JSON format)
without needing a live Electron process. Spawns the Python engine
as a subprocess and communicates over stdin/stdout.

Run:
    cd services/python-audio
    pytest tests/test_rpc_dispatcher.py -v
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
import threading
import pytest


# ─────────────────────────────────────────────────────────────────────────────
# Helper
# ─────────────────────────────────────────────────────────────────────────────

class RPCClient:
    """Thin wrapper around a running python -m app.main subprocess."""

    def __init__(self):
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "app.main"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        # Drain stderr until READY
        self._ready = threading.Event()
        self._stderr_lines: list[str] = []
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        assert self._ready.wait(timeout=15), "Engine did not print READY in 15s"

    def _drain_stderr(self):
        for line in self.proc.stderr:
            self._stderr_lines.append(line)
            if "READY" in line:
                self._ready.set()

    def call(self, method: str, params: dict) -> dict:
        req = {"id": str(uuid.uuid4()), "method": method, "params": params}
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()
        raw = self.proc.stdout.readline()
        return json.loads(raw)

    def close(self):
        self.proc.terminate()
        self.proc.wait(timeout=5)


@pytest.fixture(scope="module")
def rpc(ffmpeg_available):
    if not ffmpeg_available:
        pytest.skip("ffmpeg not available")
    client = RPCClient()
    yield client
    client.close()


# ─────────────────────────────────────────────────────────────────────────────
# Protocol tests
# ─────────────────────────────────────────────────────────────────────────────

class TestRPCProtocol:
    def test_unknown_method_returns_error_32601(self, rpc):
        resp = rpc.call("nonexistent_method", {})
        assert "error" in resp
        assert resp["error"]["code"] == -32601

    def test_missing_file_param_returns_error_32602(self, rpc):
        resp = rpc.call("analyze", {})  # file_path missing
        assert "error" in resp
        assert resp["error"]["code"] == -32602

    def test_analyze_nonexistent_file_returns_error_32000(self, rpc):
        resp = rpc.call("analyze", {"file_path": "/no/such/file.wav"})
        assert "error" in resp
        assert resp["error"]["code"] == -32000

    def test_analyze_success_returns_result(self, rpc, sine_wav):
        resp = rpc.call("analyze", {"file_path": sine_wav})
        assert "result" in resp, f"Expected result, got: {resp}"
        assert "fileInfo" in resp["result"]
        assert "loudness" in resp["result"]

    def test_analyze_result_has_lufs(self, rpc, sine_wav):
        resp = rpc.call("analyze", {"file_path": sine_wav})
        loudness = resp["result"]["loudness"]
        lufs = loudness["integratedLufs"]
        assert isinstance(lufs, (int, float))
        assert lufs < 0  # should be negative LUFS

    def test_analyze_result_has_file_info(self, rpc, sine_wav):
        resp = rpc.call("analyze", {"file_path": sine_wav})
        fi = resp["result"]["fileInfo"]
        assert fi["sampleRate"] == 44100
        assert fi["channels"] == 2

    def test_response_id_matches_request(self, rpc, sine_wav):
        req_id = "my-custom-id-12345"
        import json as j, uuid as u
        req = {"id": req_id, "method": "analyze", "params": {"file_path": sine_wav}}
        rpc.proc.stdin.write(j.dumps(req) + "\n")
        rpc.proc.stdin.flush()
        resp = j.loads(rpc.proc.stdout.readline())
        assert resp["id"] == req_id

    def test_qc_check_returns_result(self, rpc, sine_wav):
        resp = rpc.call("qc_check", {
            "file_path": sine_wav,
            "target_lufs": -14.0,
            "target_tp": -1.0,
        })
        assert "result" in resp, f"QC error: {resp}"
        assert "overall" in resp["result"]
        assert "items" in resp["result"]

    def test_error_message_is_korean(self, rpc):
        resp = rpc.call("analyze", {"file_path": "/no/file.wav"})
        msg = resp["error"]["message"]
        # Should contain Korean characters (Unicode range 가-힣)
        has_korean = any("\uAC00" <= c <= "\uD7A3" for c in msg)
        assert has_korean, f"Error message should be Korean, got: {msg!r}"

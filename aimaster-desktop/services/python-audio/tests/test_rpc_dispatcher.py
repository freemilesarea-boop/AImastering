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


# ─────────────────────────────────────────────────────────────────────────────
# What the dispatcher does with a request it did not expect
# ─────────────────────────────────────────────────────────────────────────────

class TestRPCRobustness:
    """A bad request must cost the caller an error, not the engine its life.

    The log lines sliced the id directly — `req_id[:8]` — which is fine for
    the uuid4 string the app's PythonBridge sends, and fatal for the numeric
    id JSON-RPC also allows: the slice raised TypeError inside the try, and
    the `except Exception` handler's own log line raised it again with nothing
    left to catch it.  Measured against the shipped binary: the process died
    and the write end broke, so every queued job went with it.
    """

    @staticmethod
    def _reply(client, req: dict) -> dict:
        """Send `req` and return its reply, saying so when there is none.

        Reading the line straight into `json.loads` turned a dead engine into
        `JSONDecodeError: Expecting value: line 1 column 1` — true, useless,
        and pointing at the test rather than at the engine.  An empty read
        means stdout closed, which means the process is gone.
        """
        client.proc.stdin.write(json.dumps(req) + "\n")
        client.proc.stdin.flush()
        raw = client.proc.stdout.readline()
        if raw == "":
            tail = "".join(client._stderr_lines[-6:]).strip()
            raise AssertionError(
                f"the engine answered nothing to id={req['id']!r} and its stdout closed "
                f"(exit {client.proc.poll()}) — it died on the request. stderr tail:\n{tail}"
            )
        return json.loads(raw)

    def test_numeric_id_is_answered_and_the_engine_survives(self):
        client = RPCClient()
        try:
            first = self._reply(client, {"id": 1, "method": "env_info", "params": {}})
            assert first["id"] == 1, first
            assert "result" in first, first

            # Still alive, and still answering — the point of the test.
            assert client.proc.poll() is None, "engine exited after a numeric id"
            second = client.call("nonexistent_method", {})
            assert second["error"]["code"] == -32601, second
        finally:
            client.close()

    def test_null_id_is_answered_too(self):
        client = RPCClient()
        try:
            resp = self._reply(client, {"method": "env_info", "params": {}})  # no id
            assert resp["id"] == "unknown", resp
            assert "result" in resp, resp
            assert client.proc.poll() is None
        finally:
            client.close()


# ─────────────────────────────────────────────────────────────────────────────
# Can this engine read a waveform, and does it say so
# ─────────────────────────────────────────────────────────────────────────────

class TestWaveformSupport:
    """Everything that is not a loudness figure comes from numpy + soundfile.

    When they cannot be imported the engine does not fail — it answers OK with
    `available: false` and every band at -120 dB, which the app shows as a
    damaged file.  Two PyInstaller specs produced exactly that (one dropped
    the cffi graph with `distutils`, one dropped `secrets` with setuptools),
    both reached READY, and nothing in the app could tell.  `env_info` is
    where it is now visible, and the packaged smoke reads it.
    """

    def test_env_info_reports_waveform_support(self, rpc):
        resp = rpc.call("env_info", {})
        wf = resp["result"]["environment"]["waveform"]
        assert wf["available"] is True, wf
        assert wf["reason"] is None, wf
        # A version string, not just a truthy flag — "available" with no numpy
        # behind it is the state this is here to catch.
        assert wf["numpy"] and wf["numpy"][0].isdigit(), wf
        assert wf["soundfile"] and wf["soundfile"][0].isdigit(), wf

    def test_unavailable_waveform_is_reported_with_its_reason(self, monkeypatch):
        import app.utils.audio_io as audio_io
        import app.utils.env_info as env_info

        monkeypatch.setattr(audio_io, "HAS_SF", False)
        monkeypatch.setattr(audio_io, "WAVEFORM_UNAVAILABLE_REASON",
                            "ModuleNotFoundError: No module named 'secrets'")
        monkeypatch.setattr(env_info, "_CACHE", None)

        wf = env_info.collect_env_info(use_cache=False)["waveform"]
        assert wf["available"] is False, wf
        assert "secrets" in wf["reason"], wf
        assert wf["numpy"] is None and wf["soundfile"] is None, wf

    def test_a_real_import_failure_leaves_a_reason_behind(self):
        """The test above monkeypatches the reason, so it proves the plumbing
        and not the assignment.  This one makes `import soundfile` actually
        fail — a meta_path finder that refuses the name, in a child
        interpreter — and reads what audio_io was left holding.
        """
        child = (
            "import sys\n"
            "class Block:\n"
            "    def find_module(self, name, path=None):\n"
            "        if name == 'soundfile': raise ImportError('blocked for the test')\n"
            "        return None\n"
            "    def find_spec(self, name, path=None, target=None):\n"
            "        if name == 'soundfile': raise ImportError('blocked for the test')\n"
            "        return None\n"
            "sys.meta_path.insert(0, Block())\n"
            "import app.utils.audio_io as a\n"
            "print(repr((a.HAS_SF, a.WAVEFORM_UNAVAILABLE_REASON)))\n"
        )
        proc = subprocess.run(
            [sys.executable, "-c", child], capture_output=True, text=True,
            env={**os.environ, "PYTHONUNBUFFERED": "1"}, timeout=120,
        )
        assert proc.returncode == 0, f"child failed: {proc.stderr[-800:]}"
        has_sf, reason = eval(proc.stdout.strip().splitlines()[-1])  # noqa: S307
        assert has_sf is False, proc.stdout
        assert reason and "blocked for the test" in reason, reason

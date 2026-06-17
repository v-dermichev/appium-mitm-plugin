"""mitmproxy addon: append every flow as one JSON line to ``MITM_OUT``.

Loaded by ``mitmdump -s flow_writer.py`` (the plugin spawns it). Each completed
flow is serialized as a full record: endpoint (method, scheme, host, port, url,
query), request + response headers, parsed cookies (request ``Cookie`` and
response ``Set-Cookie`` with attributes), and decoded bodies for BOTH request
and response (text when UTF-8-decodable, base64 otherwise), capped at
``MITM_MAX_BODY`` bytes. ``error`` flows (e.g. TLS handshake failures from
cert-pinned hosts) are written too, so the client can tell "pinned" from
"not captured".

Config via environment (set by the plugin):
- ``MITM_OUT``      output JSONL path (default ~/.appium-mitm/flows.jsonl)
- ``MITM_MAX_BODY`` per-body byte cap before truncation (default 131072)
"""
from __future__ import annotations

import base64
import json
import os
import threading
from typing import Any


class FlowWriter:
    """Serializes mitmproxy flows to a JSONL file, one flow per line."""

    def __init__(self) -> None:
        home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or "/tmp"
        default_out = os.path.join(home, ".appium-mitm", "flows.jsonl")
        self.out = os.environ.get("MITM_OUT") or default_out
        self.max_body = int(os.environ.get("MITM_MAX_BODY", "131072"))
        self._lock = threading.Lock()
        os.makedirs(os.path.dirname(self.out), exist_ok=True)

    def response(self, flow: Any) -> None:
        self._write({
            "id": flow.id,
            "client_ip": self._client_ip(flow),
            "method": flow.request.method,
            "scheme": flow.request.scheme,
            "host": flow.request.pretty_host,
            "port": flow.request.port,
            "url": flow.request.pretty_url,
            "http_version": flow.request.http_version,
            "request": {
                "headers": self._headers(flow.request.headers),
                "cookies": self._request_cookies(flow.request),
                "query": self._headers(flow.request.query),
                "body": self._body(flow.request),
            },
            "response": {
                "status": flow.response.status_code,
                "reason": flow.response.reason,
                "headers": self._headers(flow.response.headers),
                "cookies": self._response_cookies(flow.response),
                "body": self._body(flow.response),
            },
            "timestamps": {
                "start": flow.request.timestamp_start,
                "end": getattr(flow.response, "timestamp_end", None),
            },
        })

    def error(self, flow: Any) -> None:
        """Record connection/TLS errors (a cert-pinned host shows up here)."""
        request = getattr(flow, "request", None)
        self._write({
            "id": getattr(flow, "id", None),
            "client_ip": self._client_ip(flow),
            "host": request.pretty_host if request else None,
            "url": request.pretty_url if request else None,
            "error": str(flow.error) if getattr(flow, "error", None) else "unknown",
        })

    @staticmethod
    def _client_ip(flow: Any) -> str | None:
        conn = getattr(flow, "client_conn", None)
        peer = getattr(conn, "peername", None) if conn else None
        return peer[0] if peer else None

    @staticmethod
    def _headers(headers: Any) -> list[list[str]]:
        """Serialize a header/query multidict, preserving duplicate keys."""
        try:
            return [[k, v] for k, v in headers.items(multi=True)]
        except TypeError:
            return [[k, v] for k, v in headers.items()]

    @staticmethod
    def _request_cookies(request: Any) -> list[list[str]]:
        """Parsed request ``Cookie`` header as ``[[name, value], ...]``."""
        try:
            return [[k, v] for k, v in request.cookies.items(multi=True)]
        except Exception:  # noqa: BLE001
            return []

    @staticmethod
    def _response_cookies(response: Any) -> list[dict[str, Any]]:
        """Parsed ``Set-Cookie`` cookies with their attributes (Path, Expires...)."""
        out: list[dict[str, Any]] = []
        try:
            for name, (value, attrs) in response.cookies.items(multi=True):
                out.append({
                    "name": name,
                    "value": value,
                    "attributes": [[k, v] for k, v in attrs.items(multi=True)],
                })
        except Exception:  # noqa: BLE001
            pass
        return out

    def _body(self, message: Any) -> dict[str, Any]:
        raw = message.raw_content or b""
        truncated = len(raw) > self.max_body
        raw = raw[: self.max_body]
        try:
            return {"text": raw.decode("utf-8"), "encoding": "utf-8", "truncated": truncated}
        except UnicodeDecodeError:
            return {
                "data": base64.b64encode(raw).decode("ascii"),
                "encoding": "base64",
                "truncated": truncated,
            }

    def _write(self, record: dict[str, Any]) -> None:
        line = json.dumps(record, ensure_ascii=False)
        with self._lock, open(self.out, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")


# mitmproxy addon-registration hook (module-level by framework contract).
addons = [FlowWriter()]

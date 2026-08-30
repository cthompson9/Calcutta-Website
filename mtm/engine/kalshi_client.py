"""Minimal read-only Kalshi public API client (trade-api v2). No auth required.

Quotes come back in cents (1-99). We convert to probabilities in [0.01, 0.99].
Every raw quote should be persisted by the caller (mtm_market_quote) before
any transform runs - quotes are evidence, projections are derived.
"""
from __future__ import annotations

import time
from typing import Any, Iterator, Optional

import requests

DEFAULT_BASE = "https://api.elections.kalshi.com/trade-api/v2"


class KalshiClient:
    def __init__(self, base_url: str = DEFAULT_BASE, timeout: int = 20, max_retries: int = 3):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "calcutta-mtm/1.0"

    def _get(self, path: str, params: Optional[dict] = None) -> dict:
        url = f"{self.base_url}/{path.lstrip('/')}"
        last_err: Exception | None = None
        for attempt in range(self.max_retries):
            try:
                resp = self.session.get(url, params=params, timeout=self.timeout)
                if resp.status_code == 429:
                    time.sleep(2 ** attempt)
                    continue
                resp.raise_for_status()
                return resp.json()
            except requests.RequestException as e:  # network or 5xx
                last_err = e
                time.sleep(2 ** attempt)
        raise RuntimeError(f"Kalshi GET {path} failed after {self.max_retries} tries: {last_err}")

    def iter_markets(self, series_ticker: Optional[str] = None,
                     event_ticker: Optional[str] = None,
                     status: str = "open") -> Iterator[dict]:
        """Paginate /markets. Yields raw market dicts."""
        cursor = None
        while True:
            params: dict[str, Any] = {"limit": 200, "status": status}
            if series_ticker:
                params["series_ticker"] = series_ticker
            if event_ticker:
                params["event_ticker"] = event_ticker
            if cursor:
                params["cursor"] = cursor
            page = self._get("markets", params)
            for m in page.get("markets", []):
                yield m
            cursor = page.get("cursor")
            if not cursor:
                return

    def iter_events(self, series_ticker: str, status: str = "open") -> Iterator[dict]:
        cursor = None
        while True:
            params: dict[str, Any] = {"limit": 200, "series_ticker": series_ticker, "status": status}
            if cursor:
                params["cursor"] = cursor
            page = self._get("events", params)
            for e in page.get("events", []):
                yield e
            cursor = page.get("cursor")
            if not cursor:
                return


def market_to_quote(m: dict) -> dict:
    """Normalize a raw Kalshi market into the quote shape the transforms expect.

    yes_bid/yes_ask arrive in cents; None-safe. subtitle/yes_sub_title usually
    carries the strike ('9 or more wins') - the caller parses team + strike
    from ticker/title because formats vary by series.
    """
    def cents(v):
        return None if v in (None, 0) else round(v / 100.0, 4)

    return {
        "ticker": m.get("ticker"),
        "event_ticker": m.get("event_ticker"),
        "title": m.get("title"),
        "subtitle": m.get("subtitle") or m.get("yes_sub_title"),
        "yes_bid": cents(m.get("yes_bid")),
        "yes_ask": cents(m.get("yes_ask")),
        "last_price": cents(m.get("last_price")),
        "volume": m.get("volume"),
        "open_interest": m.get("open_interest"),
        "close_time": m.get("close_time"),
        "status": m.get("status"),
    }

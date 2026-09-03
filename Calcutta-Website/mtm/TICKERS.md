# Confirmed Kalshi NFL tickers

Verified against Kalshi's public trade API on August 29, 2026:

- Win totals series: `KXNFLWINS`
- Stage of elimination series: `KXNFLSTAGEOFELIM`
- 2026 season event pattern: `{SERIES}-27{TEAM}`
- Example win event: `KXNFLWINS-27BUF`
- Example stage event: `KXNFLSTAGEOFELIM-27BUF`

The stage market ticker suffixes map as follows:

| Suffix | Engine outcome |
| --- | --- |
| `REG` | `no_playoffs` |
| `WC` | `wild_card` |
| `DIV` | `divisional` |
| `CONF` | `conference` |
| `FL` | `sb_loss` |
| `FW` | `sb_win` |

Win-total markets use integer suffixes 1–17 and `floor_strike`. Kalshi's
current API returns fixed-point quote fields such as `yes_bid_dollars` and
`yes_ask_dollars`; the collector prefers those and retains the complete raw
market object as evidence.

Confirm both series and suffix mappings before each season rollover.
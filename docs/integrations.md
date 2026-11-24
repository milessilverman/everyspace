# Integration feasibility matrix (Everyspace)

**BLOCKER (2026-11-24):** every web fetch failed with `getaddrinfo ENOTFOUND` (airbnb.com, developer.airbnb.com, developers.expediagroup.com, connectivity.booking.com, docs.channex.io). The research session's network allowlist does not include these hosts. No official page was read, so **every platform cell below is "not verified"**. No cell is filled from memory. Re-run once these hosts (plus vrbo.com, booking.com, swimply.com, spothero.com, neighbor.com, peerspace.com, hipcamp.com, channex.io) are allowed in the session network settings. Per the stop condition, no further fetches were attempted.

## Feasibility matrix

| platform | public API | partner programme + eligibility | no-approval capability today (calendar / booking / listing / pricing / messaging) | with-approval capability | competitive-use + data restrictions | cost | confidence |
|---|---|---|---|---|---|---|---|
| Airbnb | not verified | not verified | not verified | not verified | not verified | not verified | low |
| Vrbo (Expedia Group) | not verified | not verified | not verified | not verified | not verified | not verified | low |
| Booking.com | not verified | not verified | not verified | not verified | not verified | not verified | low |
| Swimply | not verified | not verified | not verified | not verified | not verified | not verified | low |
| SpotHero | not verified | not verified | not verified | not verified | not verified | not verified | low |
| Neighbor | not verified | not verified | not verified | not verified | not verified | not verified | low |
| Peerspace | not verified | not verified | not verified | not verified | not verified | not verified | low |
| Hipcamp | not verified | not verified | not verified | not verified | not verified | not verified | low |
| Channex (connectivity provider) | not verified | not verified | not verified | not verified | not verified | not verified | low |

iCal import/export support and documented refresh latency: not verified for all nine platforms.

## Capability levels

- **L0 manual entry:** host or Everyspace staff types availability, bookings, prices and messages by hand on each platform.
- **L1 iCal availability sync:** read and/or write .ics availability feeds. Not real-time, no price or guest data. This is all Everyspace has built (15-minute cron import, per-space export feed).
- **L2 email/CSV import:** reservations or statements ingested from forwarded emails or exported files. Delayed, partial, human-triggered.
- **L3 partner API (two-way):** authenticated calendar, reservation, content, price and message sync through a platform or connectivity-provider API. Needs partner approval or a connectivity provider.
- **L4 direct booking:** Everyspace takes the guest booking and payment itself. Long-term only, and it raises competitive-use and terms questions.

## Sources

| platform | URL | retrieved | quoted constraint | supports which matrix cell |
|---|---|---|---|---|
| Airbnb | https://www.airbnb.com/help/article/99 (fetch failed, ENOTFOUND) | not retrieved (attempted 2026-11-24) | not verified | none |
| Airbnb | https://developer.airbnb.com/ (fetch failed, ENOTFOUND) | not retrieved (attempted 2026-11-24) | not verified | none |
| Vrbo (Expedia Group) | https://developers.expediagroup.com/ (fetch failed, ENOTFOUND) | not retrieved (attempted 2026-11-24) | not verified | none |
| Booking.com | https://connectivity.booking.com/ (fetch failed, ENOTFOUND) | not retrieved (attempted 2026-11-24) | not verified | none |
| Channex | https://docs.channex.io/ (fetch failed, ENOTFOUND) | not retrieved (attempted 2026-11-24) | not verified | none |
| Swimply, SpotHero, Neighbor, Peerspace, Hipcamp | not attempted (stopped after network blocker) | not retrieved | not verified | none |

## Verified / Assumptions / Recommendations

**Verified**
- Everyspace today has real iCal import (15-minute cron plus "Sync now") and a per-space/site iCal export feed, per `docs/audit/integrations-booking.md`.
- No real provider API code exists. "Direct" connections, price sync and message sync in `index.html` are simulated.
- "List once, live everywhere" copy overclaims. Real capability is L1 availability only.
- Network access to all five attempted platform hosts was blocked in this session.

**Assumptions** (unverified, do not rely on them)
- Assumption: platforms with a partner API gate it behind an application, and iCal is the only no-approval route. Not checked against any official page.
- Assumption: iCal refresh latency is minutes to hours and platform-controlled, so Everyspace's holds and 15-minute guard remain necessary.
- Assumption: marketplace-style platforms (Swimply, Peerspace, Neighbor, SpotHero, Hipcamp) may offer no public API. Nothing was read.

**Recommendations**
- Allow the platform hosts listed above in the session network settings, then re-run this research. This needs owner approval of the network change.
- Until verified, keep UI and marketing copy at L1 and relabel simulated direct/price/message sync as demo-only.
- Add an adapter interface with iCal as the first adapter, so a partner API or Channex can slot in later without a rewrite.
- Any partner application, connectivity-provider signup or platform contact requires owner approval.
- Have the owner and counsel review each platform's terms for competitive-use and scraping clauses before Everyspace's marketplace work.

# Integration feasibility matrix (Everyspace)

**Research status (2026-11-24, official public pages only, nothing submitted or contacted).** Not verified, and why:
- **Neighbor, Peerspace:** `/terms` returned HTTP 403 to automated requests. Publisher blocked automated access.
- **Swimply:** homepage and `/become-a-host` loaded, but no terms or calendar-sync page was found (4 guessed URLs returned 404). Not verified: no page located.
- **Vrbo:** only the Expedia developer hub and the Vrbo help index loaded. Connectivity Hub / Integration Central detail pages returned 404, and no Vrbo calendar help article was found.
- **Booking.com:** `connectivity.booking.com` returned an empty page. Only `developers.booking.com` loaded; the onboarding-requirements page was not reachable.
- WebFetch could not resolve any host in this session; pages were retrieved with `curl` through the proxy. Cells below with no Sources row are "not verified" or labelled "assumption".

## Feasibility matrix

Capability keys: none | iCal-read | iCal-write | manual | API. Order: calendar / booking / listing / pricing / messaging.

| platform | public API | partner programme + eligibility | no-approval capability today | with-approval capability | competitive-use + data restrictions | cost | confidence |
|---|---|---|---|---|---|---|---|
| Airbnb | Yes, but only inside "API Programs" (property/channel management, Preferred Software Partner Program); scopes set by Airbnb | Programme-based; scopes "determined by Airbnb". Open vs invitation not verified. Sign-up flow exists | iCal-read + iCal-write (calendar); booking manual; listing manual; pricing manual; messaging manual. Imports refresh every 3 h | API (scope-dependent; which scopes per programme not verified) | API Terms bar building databases from API data, analysing pricing data, and use "in a product or service that competes" with an API Program unless partner terms say otherwise. Must delete API data within 30 days of termination. Site terms bar bots/scrapers | API fee not verified | med |
| Vrbo (Expedia Group) | Expedia Group hub lists Rapid API (demand side), Connectivity Hub, Integration Central ("Integrate your connectivity product on the Vrbo platform") | Programme pages exist; eligibility not verified (detail pages 404) | iCal (calendar): not verified on a Vrbo page; Airbnb's help names VRBO as an iCal target. Others not verified | not verified | not verified (Vrbo terms not fetched) | not verified | low |
| Booking.com | Yes: Connectivity APIs (availability, rates, reservations, content, messaging), OTA/B.XML/JSON. Separate Demand API and Metasearch API | Closed to ad-hoc use: "companies must meet specific onboarding requirements"; main offering changes only via Connectivity Support. Open vs invitation not verified | iCal (calendar): not verified on a Booking.com page; Airbnb's help names Booking.com as an iCal target. Others none | API (reservations, rates and availability, content, photos, messaging, promotions, reviews) as a Connectivity Partner | Rate limits (10,000 calls/min all endpoints) can change "without prior notice". Data terms sit in the partner contract, not read | not verified | med |
| Swimply | not verified | not verified | not verified | not verified | not verified | not verified | low |
| SpotHero | No public API found. Terms mention user-authorised API access only | "Sell Parking / Operators / Property Managers" pages exist in footer; eligibility not read | manual (assumption: no iCal found) | not verified | Terms prohibit data mining, robots, spiders and any automated gathering, and reselling or copying Site content | not verified | low |
| Neighbor | not verified (403) | not verified (403) | not verified | not verified | not verified | not verified | low |
| Peerspace | not verified (403) | not verified (403) | not verified | not verified | not verified | not verified | low |
| Hipcamp | No public API found in terms | not verified | manual (assumption: no iCal found in terms) | not verified | Terms prohibit scraping or automated access and accessing Hipcamp Materials "to build a similar or competitive website, application or service" | not verified | med |
| Channex (connectivity provider) | Yes: documented PMS API (properties, rates, availability, bookings, Airbnb API, messages, webhooks) | Self-serve: free staging sandbox, no sales call. Live use needs "testing, Channex certification and OTA account authorization". Built for PMS, booking engines, in-house systems | API against a free sandbox only; live two-way sync still needs certification and per-OTA authorisation | API (calendar, rates, bookings, messaging add-on) to 78 channels incl. Booking.com, Expedia, Airbnb | Channex terms not read (`channex.io/policy`). OTA-side terms still apply (e.g. Airbnb competitive-use clause) | $130/month platform fee + $0.50 per vacation-rental unit per month (messaging add-on $0.50/unit); no setup fee, 30 days' notice | med |

iCal import/export refresh latency: Airbnb documented (every 3 hours; manual Refresh; request limits). Vrbo, Booking.com, Swimply, SpotHero, Neighbor, Peerspace, Hipcamp: not verified.

## Capability levels

- **L0 manual entry:** host or Everyspace staff types availability, bookings, prices and messages by hand on each platform.
- **L1 iCal availability sync:** read and/or write .ics availability feeds. Not real-time, no price or guest data. This is all Everyspace has built (15-minute cron import, per-space export feed).
- **L2 email/CSV import:** reservations or statements ingested from forwarded emails or exported files. Delayed, partial, human-triggered.
- **L3 partner API (two-way):** authenticated calendar, reservation, content, price and message sync through a platform or connectivity-provider API. Needs partner approval or a connectivity provider.
- **L4 direct booking:** Everyspace takes the guest booking and payment itself. Long-term only, and it raises competitive-use and terms questions.

## Sources

| platform | URL | retrieved | quoted constraint | supports which matrix cell |
|---|---|---|---|---|
| Airbnb | https://www.airbnb.com/help/article/99 | 2026-11-24 | Your Airbnb calendar automatically updates every 3 hours, and pulls in information from the other calendars you’ve connected. | Airbnb iCal latency; Vrbo/Booking.com iCal (Airbnb side only) |
| Airbnb | https://www.airbnb.com/help/article/99 | 2026-11-24 | Make sure the URL ends in .ics, because other URLs won’t work. | Airbnb calendar iCal-read |
| Airbnb | https://www.airbnb.com/help/article/3418 | 2026-11-24 | Which Scopes are available as part of an API Program or are made available to your organization is determined by Airbnb | Airbnb partner programme, with-approval |
| Airbnb | https://www.airbnb.com/help/article/3418 | 2026-11-24 | in a product or service that competes with or provides similar features or functionalities as any API Program | Airbnb competitive-use |
| Airbnb | https://www.airbnb.com/help/article/3418 | 2026-11-24 | (i) retaining static copies or building databases | Airbnb data restrictions |
| Airbnb | https://www.airbnb.com/help/article/3418 | 2026-11-24 | destroy or delete, within thirty (30) days of the effective date of termination, all Personal Data, Scopes, and Content | Airbnb data retention |
| Airbnb | https://www.airbnb.com/terms | 2026-11-24 | Do not use bots, crawlers, scrapers, or other automated means to access or collect data or other content | Airbnb anti-scraping |
| Vrbo (Expedia) | https://developers.expediagroup.com/ | 2026-11-24 | Integrate your connectivity product on the Vrbo platform | Vrbo public API / programme |
| Vrbo (Expedia) | https://developers.expediagroup.com/ | 2026-11-24 | Are you a provider of lodging inventory? Connect your properties to Expedia Group’s inventories | Vrbo programme (eligibility not stated) |
| Booking.com | https://developers.booking.com/connectivity/docs | 2026-11-24 | To become Booking.com Connectivity Partners, companies must meet specific onboarding requirements | Booking.com programme + eligibility |
| Booking.com | https://developers.booking.com/connectivity/docs | 2026-11-24 | The main offering can only be changed by contacting Connectivity Support. | Booking.com with-approval |
| Booking.com | https://developers.booking.com/connectivity/docs | 2026-11-24 | Booking.com reserves the right to 1) change these limits at any time, without prior notice | Booking.com data/limits |
| Booking.com | https://developers.booking.com/ | 2026-11-24 | Enable property owners to manage their properties on Booking.com using your site or software. | Booking.com public API |
| SpotHero | https://spothero.com/legal/terms-of-use | 2026-11-24 | using or attempting to use any data mining, “robot,” “spider,” or similar automated or manual data gathering and extraction tools | SpotHero restrictions |
| SpotHero | https://spothero.com/legal/terms-of-use | 2026-11-24 | Any use by APIs of your information will be governed by the privacy policies and terms of such APIs. | SpotHero public API |
| Hipcamp | https://www.hipcamp.com/terms | 2026-11-24 | access the Hipcamp Materials in order to build a similar or competitive website, application or service | Hipcamp competitive-use |
| Hipcamp | https://www.hipcamp.com/terms | 2026-11-24 | you shall not use any manual or automated software, devices or other processes (including but not limited to spiders, robots, scrapers, | Hipcamp anti-scraping |
| Channex | https://channex.io/pricing | 2026-11-24 | Going live also requires testing, Channex certification and OTA account authorization. | Channex programme / no-approval |
| Channex | https://channex.io/pricing | 2026-11-24 | The staging server is free — sign up at staging.channex.io and start building straight away, no sales call and no card required. | Channex no-approval (sandbox) |
| Channex | https://channex.io/pricing | 2026-11-24 | The platform fee covers your API access, the Channex dashboard, the Mapping API, unlimited user seats | Channex cost |
| Channex | https://channex.io/pricing | 2026-11-24 | Channex connects to 78 booking channels including Booking.com, Expedia, Airbnb | Channex with-approval channels |
| Channex | https://docs.channex.io/ | 2026-11-24 | Airbnb API | Channex API surface (nav entry only) |
| Swimply | https://swimply.com/become-a-host | 2026-11-24 | none found (no terms or calendar-sync text) | none |
| Neighbor, Peerspace | https://www.neighbor.com/terms ; https://www.peerspace.com/terms | 2026-11-24 | not verified — publisher blocked automated access (HTTP 403) | none |

## Verified / Assumptions / Recommendations

**Verified**
- Airbnb's API terms bar using API data for building databases or pricing analysis and bar use "in a product or service that competes" with an API Program, unless partner-specific terms differ. This is a direct risk if Everyspace later runs a marketplace.
- Airbnb's iCal import refreshes every 3 hours, with manual refresh and request limits. Everyspace's holds and 15-minute guard remain necessary.
- Booking.com's Connectivity APIs are partner-only with onboarding requirements. Channex lists Booking.com, Expedia and Airbnb among 78 channels, with a free sandbox, but live use needs certification and OTA authorisation. Cost is $130/month plus $0.50 per rental unit.
- SpotHero and Hipcamp terms prohibit automated access or scraping. Hipcamp also bars use of its materials to build a competing service.
- Everyspace today has real iCal import and export only; direct, price and message sync in `index.html` are simulated (`docs/audit/integrations-booking.md`).

**Assumptions**
- Assumption: Swimply, Neighbor, Peerspace, SpotHero and Hipcamp have no public partner API; nothing was read to confirm this.
- Assumption: Vrbo and Booking.com offer iCal export/import; only Airbnb's page names them as targets.
- Assumption: Everyspace qualifies as an "in-house system" under Channex's stated fit; not confirmed.
- Assumption: Airbnb and Booking.com live access through Channex still carries each OTA's own competitive-use terms.

**Recommendations**
- Keep product copy at L1 and relabel simulated direct, price and message sync as demo-only until a real adapter exists.
- Build an adapter interface with iCal first, so Channex or a partner API can slot in later.
- Owner and counsel to review the Airbnb API competitive-use and data-retention clauses before any marketplace work. Requires owner approval.
- Any sandbox signup, partner application or platform contact requires owner approval.
- Re-run research for Swimply, Neighbor, Peerspace, Vrbo and Booking.com iCal help with an approved method (owner to supply the terms text).

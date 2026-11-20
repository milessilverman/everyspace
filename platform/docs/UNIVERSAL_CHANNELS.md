# Universal rental management at launch

The signed-in Host Console manages external listings, reservations and calendar connections. The launch page links to the Host Console. The existing earnings tools, listing simulator and checkout remain available in the labeled demo, using its browser-local data.

## Channel support

The [integration registry](../../host/integration-catalog.mjs) records all 22 existing platforms in seven groups. It includes a source for documented provider capabilities and distinguishes implemented, provider-verified, planned, unsupported and unverified features. Calendar directions describe the provider. An import lets the provider read Everyspace's feed. An export lets Everyspace read the provider's feed. Every entry supports manual management and review of host-supplied booking email. Use Requests to record a verified external booking without an email or calendar, including a confirmation for an existing hold.

| Launch priority | Available workflow |
| --- | --- |
| Airbnb and Vrbo | Existing two-way calendar fallback and guarded manual requests. Direct APIs require approved partner access and certification. [Airbnb calendar instructions](https://www.airbnb.com/help/article/99) · [Vrbo calendar instructions](https://help.vrbo.com/articles/How-do-I-import-my-iCal-or-Google-calendar) |
| Booking.com | Calendar sync for eligible listings and manual review. Booking.com currently reports a pause on onboarding new connectivity providers. [Booking.com Partners calendar guide](https://www.youtube.com/watch?v=Smj-WfWpi4o) · [Connectivity portal](https://connect.booking.com/) |
| Swimply and Peerspace | Swimply documents both calendar directions. Peerspace documents iCal import and booking-request notifications. Hosts can also submit forwarded messages for review. [Swimply calendar sync](https://swimply.zendesk.com/hc/en-us/articles/30133735282451-Syncing-Calendar) · [Peerspace calendar import](https://support.peerspace.com/en/articles/10119394-how-to-sync-with-airbnb-vrbo-and-other-calendars-that-provide-an-icalendar-or-ics-url-link) · [Peerspace booking requests](https://support.peerspace.com/en/articles/10119524-what-happens-when-i-receive-a-booking-request) |
| Neighbor, SpotHero and Sniffspot | Manual management and forwarded-email review. Sniffspot documents writing reservations into Google Calendar. SpotHero describes operator integrations. Booking API rights for Everyspace and direct iCal support remain unverified for these platforms. [Neighbor help](https://help.neighbor.com/en_us/renter-basics-ryqU8m5c5) · [SpotHero operator integration reference](https://spothero.com/sell-parking/operators) · [Sniffspot notifications](https://help.sniffspot.com/article/375-reservation-notifications-for-hosts) |

For the remaining catalog, use provider-documented calendar directions where available and manual management otherwise. Existing calendar links stay accessible in Places & sites. The registry identifies provider programs separately from authorization for Everyspace. The Airbnb and Vrbo adapters remain disabled. Other live provider adapters require a verified official contract, authorization, test fixtures or a sandbox, certification where applicable, and security review. [Airbnb and Vrbo access](CHANNEL_RESERVATIONS.md)

## Inventory and booking safety

- Enter overnight dates in the property's time zone. The end date is exclusive. Hourly bookings can span midnight. Skipped and repeated local times require correction or an explicit offset.
- A space's capacity is its count of independently rentable units. An exclusive space has one unit. The property lock serializes allocation and checks peak concurrent occupancy across a half-open interval. A configured ancestor or descendant consumes the target's full capacity. Leave an independent driveway detached from the whole-property space when the two can be rented simultaneously.
- Cleanup minutes extend availability after occupancy. A partial cleanup period on an all-day iCal event rounds the exported end up to cover the affected day. Provider calendars may only represent a whole listing's availability, so iCal exports remain conservative for multi-unit inventory.
- Confirmed occupancy can still be recorded when a provider has already sold an overlapping slot. The calendar and conflict alerts reflect recorded capacity and buffers. An empty imported calendar with upcoming reservations is treated as an uncertain snapshot and preserves the reservations.
- Calendar refresh runs every 15 minutes in Everyspace. External providers refresh on their schedules and can confirm outside the property lock. The manual guard checks the latest available snapshot and rejects changes to the inventory or instant-book settings that invalidate that check. Hosts verify provider availability before accepting. The dormant direct approval workflow continues to require single-unit, unbuffered inventory and fresh provider proof.

## Forwarded email intake and review

Open **Requests → Import forwarded email**. Select the existing listing and paste one forwarded message or upload a saved `.eml` file of up to 128 KB. The parser extracts labeled dates, times, unit counts and a booking reference when present. Unknown formats, contradictory labels, ambiguous dates and HTML-only messages can go to manual review. Exact duplicate messages and recognized repeats of the same reservation state share one entry per listing. Changes in a provider reference's status or dates can create a separate review.

Review the dates and reference on the provider. Choose **Hold request** for a pending request or **Record existing booking** after verifying an external confirmation. A cancellation notice remains a review item. Compare an existing provider confirmation with the calendar before recording it because iCal feeds may use a different identifier. The host handles cancellations on the provider and can record verified cancellations of manually entered bookings in Calendar. Only normalized fields and a deduplication digest are stored. The input attachment, raw body and sender details are discarded. The queue is accessible only to the listing owner.

An automatic forwarding address needs an approved inbound mail relay. That rollout would need a per-listing recipient, authenticated delivery, abuse controls, data retention rules, and verification with opted-in hosts. This workflow uses host-submitted messages and requires no inbox login.

## Browser integration assessment

- **Platform permission.** Airbnb restricts unauthorized scraping and use, Booking.com requires express permission for automated access, Peerspace restricts automated access, and Vrbo's host terms restrict automatic monitoring. Host consent to view an account does not settle the provider's terms. Review the applicable provider agreement and obtain written permission for the precise workflow before proceeding. [Airbnb terms](https://www.airbnb.com/help/article/2908) · [Booking.com terms](https://www.booking.com/content/terms.html) · [Peerspace terms](https://www.peerspace.com/legal/terms) · [Vrbo host terms](https://www.vrbo.com/lp/b/host-terms-of-service)
- **Reliability.** DOM changes, localized fields, account challenges, MFA and session expiry can interrupt or misidentify a booking action. A booking mutation needs independently verifiable identity, replay protection and readback, plus safe recovery after an ambiguous response.
- **Security.** Extensions can inherit access to guest PII, authenticated requests and payment-adjacent pages. A future approved design needs least-privilege permissions, provider-issued identity, explicit host consent, isolated execution, audit logs, and a revocation and incident response flow. The current scope uses documented feeds, authorized integrations and manual actions.

## Local verification

From `platform/`, run `npm ci`, `npm test` and `npm run test:concurrency`. The concurrency suite uses a disposable PostgreSQL Docker container. Run `node --test tests/*.test.mjs` from the repository root for the legacy demo suite. Apply the catalog and inventory migrations to a local database before exercising the new Host Console and email input. Production services and third-party accounts require their own rollout after review.

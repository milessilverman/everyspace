# Everyspace game plan

**Launch goal:** manage rentals across the 22 existing channels. The Host Console is the launch product. Marketplace, checkout, and simulated provider connections are part of the labeled demo.

**Launch market:** Los Angeles. Revenue share applies to attributed host revenue. Paid services and production rollout need founder approval.

**Current pilot status:** staging verification only. PR #8 contains the reliability audit and provider research across all 22 channels. The audit identifies the checks needed before a supervised pilot and the provider permissions needed before any automation. [Technical audit](TECHNICAL_AUDIT.md) · [Provider audit](PROVIDER_AUDIT.md)

## Catalog and reservation audit

- The two demo pages have the same 22-entry `PLATFORMS` catalog. The Host Console and Postgres lacked Giggster, EVmatch, The Kitchen Door, LiquidSpace, SpareRoom, and Zillow Rentals.
- The live foundation syncs iCal every 15 minutes, stores manual request holds, and flags recorded overlaps. Provider refresh timing varies. The existing overlap count can reject sequential reservations against the same multi-unit request even when there is spare capacity. Booking occupancy also needs a turnover buffer and explicit handling of daylight saving at hourly boundaries.
- Draft PR #6 defined an adapter boundary. Draft PR #7 added durable intake, audit logs, property locking, and confirmation recovery for Airbnb and Vrbo. PR #8 expands the catalog and hardens the local reservation workflow. Live adapters are disabled. [PR #6](https://github.com/milessilverman/everyspace/pull/6) · [PR #7](https://github.com/milessilverman/everyspace/pull/7) · [PR #8](https://github.com/milessilverman/everyspace/pull/8)

## Implementation order

1. Complete the channel catalog and Host Console capability registry. Prioritize Airbnb, Vrbo, Booking.com, Swimply, Peerspace, Neighbor, SpotHero, and Sniffspot for verified connection setup.
2. Extend existing locks and guards with half-open hourly and overnight ranges, time-zone validation, cleanup buffers, and concurrent unit capacity. A configured parent space shares occupancy with its descendants. Independent spaces at the same property can book concurrently.
3. Add signed-in intake of forwarded messages and a review queue. Deduplicate within a listing, require host review, and route reviewed requests through the existing hold workflow.
4. Validate the migration and management-only entry point locally. Retest existing calendar workflows and the disabled provider decision engine.
5. Pursue partner access or an approved inbound mail relay separately. Evaluate platform permission, operational reliability, and security before any browser-based integration.

## How we make money

We take a share only of revenue Everyspace actually brought in. A booking counts if:

- the space was added by Everyspace (a driveway, pool, garage or room the host wasn't renting before), or
- Everyspace helped publish the listing on that site.

We never charge on an Airbnb listing the host already ran themselves. "We only get paid when we make you more" is the pitch.

- **Rate (decided):** each host, each month, **10% until our fee reaches $30, then 3%** on the rest of that month.
  - Example: $1,000 of extra bookings in a month → $30 + $21 = **$51 (5.1%)**. Bigger months trend toward 3%.
  - Airbnb co-hosts typically take 10–25% of *everything*. We take a few percent of only the *new* money.
  - The three numbers live in `app_settings` (`intro_share_pct`, `intro_fee_cap_cents`, `standard_share_pct`) and can change any time.
- **Accrual:** finished stays go into `earnings_ledger` once a day (`accrue_earnings()`).
  - It is idempotent, so re-running never double-charges.
  - Card collection (Stripe) comes later and **needs approval**: Stripe charges per transaction.

## Booking safety and connections

Everyspace uses a property lock for holds and reservation changes. One external listing per related space family can be configured for Instant Book. Hosts verify closures and outside bookings directly with the relevant providers. iCal is a delayed fallback that publishes and reads busy slots. Each provider controls when it rereads a feed. Calendar links can lag behind external confirmations and cannot guarantee availability.

The channel registry distinguishes implemented Everyspace workflows, capabilities verified in provider documentation, planned work, explicitly unsupported paths, and unverified capabilities. Manual management is available across the catalog. The provider approval requirements are maintained separately. [Reservation connectivity and approvals](CHANNEL_RESERVATIONS.md)

## Phases

1. **Foundation. Done.**
   - Database with row-level security on every table.
   - Two-way calendar sync.
   - Double-booking detection across sites, including whole-house vs room.
   - Revenue-share ledger.
   - One configured instant site per related inventory, holds, calendar checks and the booking guard.
   - 34 automated tests.
2. **Go live on the free tier. Done (Nov 16, 2026).**
   - Supabase project `everyspace` (ref `hnzcwfvxpfsyjpbebevp`, West US, free plan, $0).
   - Database, the three functions, calendar sync every 15 minutes, and the daily revenue-share run are all live.
   - Tested end to end on the live system with a throwaway host, then deleted:
     - hold → "close Dec 1–4 on Airbnb";
     - competing request refused;
     - dates closed → "safe to accept";
     - guard flagged a stay accepted without the check.
   - **Host Console** (`host/` in the GitHub repo) connects to it:
     - sign-in;
     - places, spaces and sites;
     - two-way calendar links;
     - choosing the one instant site;
     - requests with "Safe to accept";
     - calendar, alerts and earnings.
     Tested in a real browser against the live system on desktop and phone, in light and dark mode.
3. **First 10 LA hosts, by hand.**
   - Silver Lake, Venice, Echo Park, Highland Park, Culver City.
   - Add calendar links for them.
   - List their unused spaces on the sites that fit:
     - Driveways → Neighbor / SpotHero.
     - Pools → Swimply.
     - Backyards and studios → Peerspace.
     - Garages → Neighbor.
   - Prove the attributed revenue.
4. **Host operations.**
   - Forwarded booking-email parsing and host review.
   - Guest-message drafting.
   - Price suggestions using LA demand: events at SoFi, Crypto.com Arena and the Hollywood Bowl, plus beach weekends.
   - Model API usage costs money, so **ask first**.
5. **Deeper connections.**
   - Channel manager or partner APIs once the volume justifies it.
   - Schedule browser integration work only after written permission and validation of the security and reliability requirements.
6. **Payments.**
   - Stripe Connect to collect the revenue share automatically (**ask first**).

## What still needs the founder

- [x] Free Supabase project created (Nov 16, 2026).
- [x] Pricing: 10% until $30/month, then 3%.
- [ ] Domain name: `everyspace.app` is assumed in the code. Buying one costs about $10–20/yr, so **ask first**.
- [ ] LA compliance before hosting whole homes:
  - LA's Home-Sharing Ordinance applies: primary residence, a registration number on every listing, and a 120-day cap without an extended permit.
  - Hourly spaces (pools, driveways) follow different rules.

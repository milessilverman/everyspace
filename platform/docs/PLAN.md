# Everyspace game plan

**Goal:** one place that runs every rental site for a host: Airbnb, Vrbo, Booking.com, Swimply, Peerspace, Neighbor, Hipcamp and the rest. AI does the work. Hosts keep using Airbnb exactly as they do today, and Everyspace earns them more on top.

**Launch market:** Los Angeles.
**Pricing:** a share of the revenue Everyspace brings in. No monthly fee.
**Rule:** nothing that costs money gets turned on without the founder approving it first.

---

## How we make money

We take a share only of revenue Everyspace actually brought in. A booking counts if:

- the space was added by Everyspace (a driveway, pool, garage or room the host wasn't renting before), or
- Everyspace published the listing on that site, or
- the booking came through the Everyspace marketplace.

We never charge on an Airbnb listing the host already ran themselves. "We only get paid when we make you more" is the pitch.

- **Rate (decided):** each host, each month, **10% until our fee reaches $30, then 3%** on the rest of that month.
  - Example: $1,000 of extra bookings in a month → $30 + $21 = **$51 (5.1%)**. Bigger months trend toward 3%.
  - Airbnb co-hosts typically take 10–25% of *everything*. We take a few percent of only the *new* money.
  - The three numbers live in `app_settings` (`intro_share_pct`, `intro_fee_cap_cents`, `standard_share_pct`) and can change any time.
- **Accrual:** finished stays go into `earnings_ledger` once a day (`accrue_earnings()`).
  - It is idempotent, so re-running never double-charges.
  - Card collection (Stripe) comes later and **needs approval**: Stripe charges per transaction.

## No double bookings, ever

Calendar links alone can't promise this. Each site re-reads the others on its own schedule; Airbnb's is every few hours, sometimes up to 12. If two sites can both confirm a guest instantly, someone can book in that gap. So the promise comes from rules about who can say yes, enforced in the database:

1. **One open door.**
   - For any space, only one site takes Instant Book. Usually that's the site the host already gets the most bookings from.
   - Every other site is request-to-book.
   - The database refuses a second instant site, including a room inside a whole house that's instant somewhere else.
2. **Hold → close → verify → accept.**
   - When a request arrives on another site, Everyspace holds the dates under a lock. No second request or booking can take them.
   - The host then closes those dates on the instant site. Later, with a direct connection, Everyspace does this itself.
   - Everyspace reads the instant site's calendar live to prove the dates are closed. Only then does it say **"Safe to accept."**
   - If a guest grabbed the dates on the instant site first, it says **"Decline."**
3. **Guard.** Every 15 minutes Everyspace checks two things:
   - that the instant site still shows every other booking as closed;
   - that no request was accepted without the check.
   Either problem raises an alert.
4. **Calendar sync as a backup layer.**
   - Our feed also blocks the dates on every site within hours.
   - Double-booking detection covers the whole house and the rooms inside it.

**What it depends on until direct connections are approved:**
- The host doesn't tap "accept" on a request before Everyspace says it's safe.
- The host doesn't reopen dates that Everyspace closed.
- The guard catches either within 15 minutes.
- Direct connections (Phase 5) remove the host from the loop entirely: Everyspace closes the dates and accepts or declines by itself.

**Booking.com:**
- Its calendar export can't tell a closed date from a booking.
- Request-to-book only exists for brand-new Booking.com listings.
- So an existing Booking.com listing is either the one instant site, or waits for the direct connection.

**Everyspace marketplace:** bookings must use the same lock (`place_hold`) when it launches.

## How we connect to each site (without making hosts change anything)

| Method | What it does | Works today? | Cost |
|---|---|---|---|
| **Calendar links (iCal)** | Reads each site's calendar and publishes one back per site, so a booking anywhere blocks the dates everywhere. | **Yes. Built and tested.** | $0 |
| Booking email reading | The host forwards booking emails (or connects Gmail read-only). We pull guest, price and dates. | Next | $0 |
| Channel manager API (e.g. Channex) | Real two-way sync for Airbnb, Vrbo and Booking.com: prices, messages, listings. | Needs partner approval | **Paid per listing. Ask first.** |
| Official partner APIs | Airbnb, Booking.com and Vrbo connectivity programs. | Apply once we have traction | Free, but gated |
| Browser extension | Acts on sites with no API (Swimply, Peerspace, Neighbor) while the host is logged in. | Later | $0 |

We never store passwords for other sites. API tokens will go in Supabase Vault.

## Phases

1. **Foundation. Done.**
   - Database with row-level security on every table.
   - Two-way calendar sync.
   - Double-booking detection across sites, including whole-house vs room.
   - Revenue-share ledger.
   - No-double-booking rules: one instant site, holds, live verification and the guard.
   - 31 automated tests.
2. **Go live on the free tier. Done (Nov 16, 2026).**
   - Supabase project `everyspace` (ref `hnzcwfvxpfsyjpbebevp`, West US, free plan, $0).
   - Database, the three functions, calendar sync every 15 minutes, and the daily revenue-share run are all live.
   - Tested end to end on the live system with a throwaway host, then deleted:
     - hold → "close Dec 1–4 on Airbnb";
     - competing request refused;
     - dates closed → "safe to accept";
     - guard flagged a stay accepted without the check.
   - Next: connect the demo app's sign-in, calendar and requests screens to it.
3. **First 10 LA hosts, by hand.**
   - Silver Lake, Venice, Echo Park, Highland Park, Culver City.
   - Add calendar links for them.
   - List their unused spaces on the sites that fit:
     - Driveways → Neighbor / SpotHero.
     - Pools → Swimply.
     - Backyards and studios → Peerspace.
     - Garages → Neighbor.
   - Prove the attributed revenue.
4. **AI operations.**
   - Booking-email parsing.
   - Guest-message drafting.
   - Price suggestions using LA demand: events at SoFi, Crypto.com Arena and the Hollywood Bowl, plus beach weekends.
   - Model API usage costs money, so **ask first**.
5. **Deeper connections.**
   - Channel manager or partner APIs once the volume justifies it.
   - Browser extension for sites with no API.
6. **Payments.**
   - Stripe Connect to collect the revenue share automatically (**ask first**).

## What still needs the founder

- [x] Free Supabase project created (Nov 16, 2026).
- [x] Pricing: 10% until $30/month, then 3%.
- [ ] Domain name: `everyspace.app` is assumed in the code. Buying one costs about $10–20/yr, so **ask first**.
- [ ] LA compliance before hosting whole homes:
  - LA's Home-Sharing Ordinance applies: primary residence, a registration number on every listing, and a 120-day cap without an extended permit.
  - Hourly spaces (pools, driveways) follow different rules.

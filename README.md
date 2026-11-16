# Everyspace

Free rental management for everything you rent out: homes, rooms, backyards, pools, parking, storage, roofs and more.

- One calendar and one inbox for Everyspace, Airbnb, Vrbo, Booking.com, Expedia, Swimply and other sites
- Calendar sync, double-booking alerts and price sync ("list once, live everywhere")
- Turnovers and tasks, expenses and profit, permits and insurance reminders
- Earnings quiz, pricing help, private neighbor offers and cleaning-gap rentals
- Also a marketplace with a 3% host fee and all-in prices for renters

**Live site:** https://milessilverman.github.io/everyspace/

`index.html` and `everyspace.html` are the same single-file app. It runs entirely in the browser with demo data (saved in your browser's local storage); connections to other sites are simulated until partner integrations and a backend are in place.

## Host Console (`host/`)

[`host/index.html`](host/index.html) is the real, signed-in app for hosts, connected to the live backend. Once it's on `main` it will be at `https://milessilverman.github.io/everyspace/host/`. Hosts can:

- add places, spaces (a room can sit inside the whole home) and the sites each is listed on;
- connect each site's calendar both ways, with copy-paste links and steps for each site;
- choose the one site that takes instant bookings;
- add a request before accepting it, and get "Close these nights on Airbnb", then "Safe to accept", or "Decline";
- see alerts, a calendar across every site, and earnings.

## Backend (`platform/`)

The real backend now lives in [`platform/`](platform/). It runs on Supabase's free plan in West US, launching in Los Angeles. It has:

- **Two-way calendar sync** with Airbnb, Vrbo and others, every 15 minutes.
- **No-double-booking rules:** one instant-book site per space; requests on other sites hold the dates, and are marked safe to accept only after the dates are proven closed everywhere; plus a guard that flags anything that slips.
- **Revenue-share billing:** 10% of the extra money Everyspace brings in, until the fee reaches $30 in a month, then 3%.

See [`platform/README.md`](platform/README.md) and the game plan in [`platform/docs/PLAN.md`](platform/docs/PLAN.md).

## Next version of the app (`next/`)

[`next/index.html`](next/index.html) is the newest version of the app, adding:

- earnings quiz, gear and rides categories, and the realistic publish flow;
- ride cursors and color themes.

It isn't the live site yet, because the tests below still target the current `index.html`.

## Tests

The core rules (pricing, the price rule, iCal sync, listing everywhere, privacy) have automated tests:

```bash
node --test tests/*.test.mjs
```

They load the app's domain code straight from `index.html`, so the site stays a single file.

The backend has its own 31 tests. From `platform/`:

```bash
npm install
```

```bash
npm test
```

## What's needed before launch

The app is a complete, working front end with demo data. To take real bookings it still needs:

1. **Accounts and a backend.** Real sign-in, a database, and server-side checks that the person making a request owns the listing or booking (the demo API trusts the user ID it's given).
2. **Payments.** Stripe Connect (or similar) for renter charges, deposits held on card, and host payouts.
3. **Partner connections.** Approval from Airbnb, Booking.com and Expedia Group (Vrbo/Expedia) partner programs for direct listing, price and calendar updates. Until then those sites use iCal sync plus our listing team.
4. **A listing team (or tooling)** to post to sites without a direct connection (Swimply, Peerspace, Neighbor and others) and confirm each is live.
5. **Verified fees.** Other sites' fees are estimates in one table (`PLATFORMS` in the code), labeled as estimates in the app until checked.
6. **Legal and insurance.** Terms, privacy policy, host protection insurance, lease and infrastructure agreement templates, and local short-term-rental rules.
7. **Photos.** Upload and storage for listing photos (the demo draws each space).

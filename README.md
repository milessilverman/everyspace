# Everyspace

Free rental management for everything you rent out: homes, rooms, backyards, pools, parking, storage, roofs and more.

- One calendar and one inbox for Everyspace, Airbnb, Vrbo, Booking.com, Expedia, Swimply and other sites
- Calendar sync, double-booking alerts and price sync ("list once, live everywhere")
- Turnovers and tasks, expenses and profit, permits and insurance reminders
- Earnings quiz, pricing help, private neighbor offers and cleaning-gap rentals
- Also a marketplace with a 3% host fee and all-in prices for renters

**Live site:** https://milessilverman.github.io/everyspace/

`index.html` and `everyspace.html` are the same single-file app. It runs entirely in the browser with demo data (saved in your browser's local storage); connections to other sites are simulated until partner integrations and a backend are in place.

## Tests

The core rules (pricing, the price rule, iCal sync, listing everywhere, privacy) have automated tests:

```bash
node --test
```

They load the app's domain code straight from `index.html`, so the site stays a single file.

## What's needed before launch

The app is a complete, working front end with demo data. To take real bookings it still needs:

1. **Accounts and a backend.** Real sign-in, a database, and server-side checks that the person making a request owns the listing or booking (the demo API trusts the user ID it's given).
2. **Payments.** Stripe Connect (or similar) for renter charges, deposits held on card, and host payouts.
3. **Partner connections.** Approval from Airbnb, Booking.com and Expedia Group (Vrbo/Expedia) partner programs for direct listing, price and calendar updates. Until then those sites use iCal sync plus our listing team.
4. **A listing team (or tooling)** to post to sites without a direct connection (Swimply, Peerspace, Neighbor and others) and confirm each is live.
5. **Verified fees.** Other sites' fees are estimates in one table (`PLATFORMS` in the code), labeled as estimates in the app until checked.
6. **Legal and insurance.** Terms, privacy policy, host protection insurance, lease and infrastructure agreement templates, and local short-term-rental rules.
7. **Photos.** Upload and storage for listing photos (the demo draws each space).

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

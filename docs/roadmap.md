# Roadmap

Order of growth: management tools -> free income estimator -> multi-space discovery -> marketplace partnerships -> host network -> direct bookings -> marketplace only when supply and demand justify it. Thresholds marked (proposed) are recommendations for the owner to confirm, not measured facts.

## Phases
| phase | scope | depends on | can run in parallel with | acceptance criteria |
|---|---|---|---|---|
| 0 Audit + design | audits, this doc set | — | — | docs exist; no blocking conflict or high-severity security issue |
| 1 Foundation | orgs/roles, lookup tables, availability + conflict engine, provider adapters (iCal, manual), sync resilience | 0 | 2 | all migrations replay on Postgres 16 and PGlite; RLS test covers every table; race tests: exactly one winner in each contested case; adapter can be added/removed by one file; existing 34 platform tests still pass |
| 2 Property intelligence | address -> parcel -> profile with provenance; owner corrections | 0 | 1 | every attribute has tag, source, date, confidence; failed lookups return a reason, never a guess; owner value survives a later refresh; one live spot-check per source |
| 3 Revenue discovery | opportunities, regulatory check, revenue model, optimizer, public estimator | 2 | end of 1 | every figure shows inputs, source, 3 scenarios, confidence; formulas tested to the cent; optimizer total <= naive sum and respects conflicts; estimator usable without sign-in; browser end-to-end test passes |
| 4 Host acquisition + accuracy | onboard first hosts by hand; measure estimate vs actual | 1-3 live (approval A2) | 5 preparation | consent recorded per host; median absolute % error per category reported; share of actuals inside the conservative-optimistic band reported; no cross-host data shown below a minimum cohort size (proposed: 10 hosts per category and area) |
| 5 Marketplace partnerships | apply to official partner / connectivity programmes | 4 evidence; owner approval per application | 4 | per platform: programme terms reviewed, competitive-use clause checked against Everyspace's stated long-term intent, data-retention rules implemented in `provider_data` before any API data is stored |
| 6 Direct bookings, then marketplace | host-controlled direct booking links; public marketplace last | readiness gate below | — | every gate metric met for two consecutive quarters (proposed) |

## Phase 4 detail: accuracy measurement with authorised, privacy-preserving host data
| item | rule |
|---|---|
| Data used | only a host's own `revenue_entries`/`reservations` in Everyspace, with explicit opt-in to accuracy measurement |
| Never used | restricted marketplace API data; guest personal data; another host's raw figures |
| Aggregation | category x area x month; suppressed below the minimum cohort size |
| Output | calibration report; updated defaults with source "Everyspace host aggregate, n=…, period …" replacing "planning default (uncited)" |
| Host benefit | their own estimate-vs-actual view and a tighter forecast |

## Phase 5 detail: partnership approach
| principle | practice |
|---|---|
| Honest about intent | every application states that Everyspace is a multi-channel management tool and may later offer host-controlled direct booking; no application is made where terms forbid that without disclosure and agreement |
| Evidence of value to platforms | more complete calendars (fewer double bookings/cancellations), new supply types listed for the first time, faster host response; measured from Phase 4 data |
| No workaround | until approved: iCal and host-uploaded files only; no scraping, no credential sharing, no automation of a platform's website |
| Order | platforms whose official programmes are open to software providers first (to be established in `docs/integrations.md`) |

## Phase 6 gate: readiness criteria for direct bookings and a marketplace
| criterion | metric | threshold (proposed) |
|---|---|---|
| Active hosts | hosts with a synced calendar and a booking in the last 90 days | 250 in one metro |
| Inventory | bookable spaces with verified availability | 1,000 in that metro, at least 4 categories |
| Geographic concentration | share of inventory within one metro | >= 60% |
| Demand | unprompted direct-booking requests reported by hosts; search interest for the metro | measured for 2 quarters before any spend |
| Booking reliability | double-booking rate; calendar staleness | < 0.1% of bookings; < 1% of calendars stale |
| Retention | hosts active after 6 months | >= 70% |
| Unit economics | contribution per host after payment, support and insurance cost | positive for 2 quarters |
| Payments | licensed processor with payouts, deposits, refunds, tax reporting | contracted and tested |
| Insurance | host protection and liability cover in force | bound policy |
| Trust and safety | ID verification, reviews, incident process, 24h response | staffed and rehearsed |
| Compliance | per-jurisdiction rules encoded and verified for every listed category | 100% of listed spaces |
| Support | staffed channel with response-time target | met for 1 quarter |
| Agreement compatibility | every partner/connectivity agreement reviewed for direct-booking and marketplace clauses | written confirmation or exit from conflicting agreements |

## Monetization sequence (detail and costs in `docs/costs.md`)
| stage | stream | rule |
|---|---|---|
| now | estimator and core management | free; no charge before an owner sees their potential |
| after Phase 4 | revenue share on income Everyspace added (existing plan); optional subscription for automation, multi-property and analytics | must exceed its integration, data, infrastructure, support and payment cost per host |
| after Phase 5 | integration services, reports, enterprise | priced per property; partner fees passed through transparently |
| after Phase 6 | booking fees / commissions | only on direct bookings |

## Not on the critical path (one line each)
Photo upload UI · hosted staging project · server-side property-intel function with caching · email booking parser · hourly calendar view · team invitations UI · moving `index.html` demo onto `core/` · PostGIS.

**Verified:** phases 0-3 criteria are checked by the test suites named in `docs/STATE.md`. **Assumptions:** all proposed thresholds. **Recommendations:** approve A2 early; choose one metro and hold to it until the Phase 6 gate.

# Schema proposal (migration plan)

Status: **proposed; applied to local staging only.** Nothing here touches the live project until approval A2 (`docs/STATE.md`). The live database had 0 user rows on 2026-11-24 (`docs/audit/database.md`), so every change below is non-destructive there.

Principles: Everyspace owns its records under its own UUIDs; external ids are attributes, never keys. Additive and backward compatible: the Host Console keeps working unchanged. Categories, platforms, roles and rules are rows, not enums. RLS on every table, one membership choke point.

## Migration order
| # | file (in `platform/supabase/migrations/`) | adds | changes to existing objects | reversible |
|---|---|---|---|---|
| M0 | rename the 6 files to the live versions (`20261116050935_init`, `…051049_no_double_booking`, `…051137_pricing`, `…052016_cron_secret`, `…052245_indexes`, `…110046_alerts_polish`); add `…051641_enable_scheduling_extensions`, `…052212_move_pg_net_to_extensions_schema` as guarded no-ops where the extension is missing | none | none (history now matches live) | yes |
| M1 | `20261124010000_orgs_roles.sql` | `organizations`, `roles`, `memberships`; `has_org_permission(org, perm)`, `can_view_space`, `can_manage_space` | `properties.org_id` (backfilled to a personal org, then `not null`); `channel_connections.org_id`; `handle_new_user` also creates the personal org + owner membership; `owns_space()` body becomes membership-based; policies split into read (`*.read`) and write (`*.write`) | yes |
| M2 | `20261124020000_catalog.sql` | `channels`, `space_categories`, `amenities`, `space_amenities` | enum `channel` columns (6 tables) become `text` with FK to `channels(key)`; functions taking `public.channel` are recreated with `text`; `site_name()` reads `channels`; `spaces.category` gets FK to `space_categories(key)`; enum dropped last | yes (type change only) |
| M3 | `20261124030000_property_intelligence.sql` | `parcels`, `buildings`, `property_attributes`, view `property_profile`, `property_photos`, `regulatory_rules`, `property_regulatory`, `opportunities`, `projections`, `provider_data`; RPC `confirm_attribute`, `purge_expired_provider_data` | none | yes |
| M4 | `20261124040000_operations.sql` | `pricing_rules`, `expenses`, `revenue_entries`, `maintenance_tasks`, `communications` | `reservations.source`, `reservations.guest_count`, `reservations.import_batch_id` | yes |
| M5 | `20261124050000_availability.sql` | `space_relations`, `resources`, `space_resources`; `blocking_spaces()`, `availability_conflicts()`, `create_booking()`, `import_reservations()`, view `sync_health` | `spaces.setup_minutes`, `spaces.cleanup_minutes`; `reservations.exclusive`; exclusion constraint (needs `btree_gist`); direct `insert/update/delete` on `reservations` revoked from `authenticated` (RPC only); `detect_conflicts` made quantity-, relation- and resource-aware; `calendar_imports.consecutive_failures`, `last_ok_at` | yes |

## Tables
| table | key columns | tenant key | RLS |
|---|---|---|---|
| `organizations` | `id, name, kind (personal/team), created_by` | self | members read; `org.manage` writes |
| `roles` | `key, label, permissions text[]` (seed: owner, admin, manager, operator, viewer) | global | read all signed-in; service role writes |
| `memberships` | `org_id, user_id, role_key, status`; unique (org, user) | org | members read; `org.manage` writes; a user cannot raise their own role |
| `channels` | `key, name, kind, cap_calendar, cap_booking, cap_listing, cap_pricing, cap_messaging` (each `L0`-`L4`), `active` | global | read all (incl. anon); service role writes |
| `space_categories` | `key, label, group_key, units text[], active` | global | read all; service role writes |
| `amenities` / `space_amenities` | `key, label` / `space_id, amenity_key, provenance_tag` | global / via space | read all / space rules |
| `parcels` | `id, property_id, apn, jurisdiction jsonb, boundary jsonb (GeoJSON), lot_area_sqft` | via property | property rules |
| `buildings` | `id, property_id, parcel_id, kind, footprint jsonb, footprint_sqft, stories, year_built` | via property | property rules |
| `property_attributes` | `id, property_id, subject_type, subject_id, key, value jsonb, unit, provenance_tag (measured/estimated/owner_confirmed/unavailable), source_name, source_url, license, retrieved_at, confidence, method, created_by, created_at, superseded_at` — append-only | via property | read: viewers; insert: managers; no update of `value`, no delete |
| `property_profile` (view, `security_invoker`) | current value per (property, subject, key): newest `owner_confirmed`, else highest confidence then newest | via property | inherits |
| `property_photos` | `id, property_id, space_id, storage_path, source ('owner_upload'), license, uploaded_by` | via property | property rules |
| `regulatory_rules` | `id, jurisdiction_key, category_key, rule_type, effect, summary, params jsonb, source_url, verified, verified_at` | global | read all; service role writes |
| `property_regulatory` | `property_id, rule_id, status, permit_number, expires_at, provenance_tag` | via property | property rules |
| `opportunities` | `id, property_id, category_key, basis, status, feasibility jsonb, projection_id` | via property | property rules |
| `projections` | `id, property_id, org_id, model_version, goal, inputs jsonb, assumptions jsonb, scenarios jsonb, confidence, created_by` — immutable | org | members read; managers insert |
| `provider_data` | `id, channel_key, org_id, space_id, kind, payload jsonb, retrieved_at, expires_at not null` | org | members read own; service role writes; purged daily; no FK from any intelligence table |
| `pricing_rules` | `id, space_id, channel_key, rule_type, unit (hour/day/night/week/month), amount_cents, starts_on, ends_on, dow int[], min_units, priority` | via space | space rules |
| `expenses` | `id, org_id, property_id, space_id, category, amount_cents, incurred_on, recurring, note` | org | `finance.read` / `finance.write` |
| `revenue_entries` | `id, org_id, property_id, space_id, reservation_id, channel_key, gross_cents, platform_fee_cents, cleaning_cents, tax_cents, net_cents (generated), earned_on, source` | org | `finance.read` / `finance.write` |
| `maintenance_tasks` | `id, property_id, space_id, reservation_id, kind, due_at, status, assigned_to` | via property | viewers read; managers write; assignee may update status |
| `communications` | `id, org_id, space_id, reservation_id, channel_key, direction, body, sent_at, source` | org | members read; managers write |
| `space_relations` | `id, property_id, space_id, blocks_space_id, reason (contains/privacy/access/noise/other), symmetric` | via property | space rules |
| `resources` / `space_resources` | `id, property_id, key, kind (entrance/bathroom/parking/kitchen/laundry/other), capacity` / `space_id, resource_id, units` | via property | space rules |

## Availability rules (M5), enforced in SQL under `lock_property`
| rule | definition |
|---|---|
| Time | half-open `tstzrange(starts_at, ends_at)`; hourly through monthly use the same range |
| Buffers | a reservation occupies `[starts_at - setup_minutes, ends_at + cleanup_minutes)` of its own space; buffers do not extend onto related spaces |
| Family | a space is blocked by reservations on itself, its ancestors and descendants (existing `related_spaces`) |
| Relations | `space_relations(space_id A, blocks_space_id B)`: a booking on A blocks B; `symmetric` blocks both ways. No row = independent (an ADU does not block the driveway) |
| Capacity | a space with `quantity = n` accepts up to n overlapping bookings |
| Shared resources | sum of `units` over overlapping bookings of spaces using a resource must stay <= `resources.capacity` |
| Holds | active `booking_holds` count as occupancy (existing behaviour) |
| External facts | `import_reservations` always records what a marketplace reports, then flags conflicts; it never rejects reality. `create_booking` (Everyspace-originated) is rejected on any conflict |
| Constraint | `exclude using gist (space_id with =, tstzrange(starts_at, ends_at) with &&) where (exclusive and status = 'confirmed')`; `exclusive` is set only by `create_booking` on `quantity = 1` spaces |

## Verification (staging)
`platform/tests`: every migration replayed on PGlite; RLS tests per table (other tenant sees 0 rows, viewer cannot write, anon sees only lookups); existing 34 tests stay green; `npm run test:staging` replays on local Postgres 16 and runs two-connection race tests.

## Not in scope this run
Storage bucket for photos; Stripe tables; messaging beyond a log table; PostGIS (GeoJSON in `jsonb` is enough for one-property geometry).

**Verified:** existing schema and live state (`docs/audit/database.md`). **Assumption:** Supabase keeps `btree_gist` available on the free plan (it is in the extension list per platform docs; check at apply time). **Recommendation:** approve A2 while the live database is still empty.

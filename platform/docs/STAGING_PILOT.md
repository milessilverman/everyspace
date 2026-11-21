# Staging verification and supervised pilot

## Reproduce the staging deployment

Run from the repository root on a machine with Docker, Git, tar, Node 24, Deno 2.7, Chromium and curl. This uses the existing workspace’s compute and downloads pinned test dependencies and images if absent. Project access and cloud credentials are unnecessary.

```sh
npm ci --prefix platform
npm run test:staging --prefix platform
```

Set `DENO_BIN` or `CHROMIUM_EXECUTABLE` if either executable uses a different path. The browser uses the pinned Supabase SDK referenced in the Console, with the existing integrity check. For offline tests, set `STAGING_BROWSER_SDK_DIR` to a cache containing the exact bundles as `supabase-2.119.2.js` and `supabase-2.45.4.js`. The single-file override `STAGING_BROWSER_SDK_FILE` supplies the current bundle. Deno and Docker still need their dependency and image caches. The Git history must contain the pre-upgrade revision `859af1c`.

The runner creates disposable PostgreSQL 17.7, GoTrue v2.188.1, PostgREST v14.10 and local Deno services. It uses a per-run Docker network and random synthetic credentials, database and ports. The database has no published port. Auth, REST, Edge Functions and the web entry point bind or publish to loopback. The browser blocks off-origin requests and the Edge runner accesses only its local gateway and explicitly substituted fixture calendars. Credentials and backups stay within disposable test resources. The runner deletes its containers, database volumes and temporary files on completion.

The suite installs the baseline migrations and explicit API grants, creates two synthetic accounts and saves a pre-upgrade database backup. It applies the candidate migrations, reloads the local schema cache and tests the Console against Auth, REST, RLS and the actual Edge handlers. A local gateway maps synthetic publishable and secret API keys to the local roles. Use `STAGING_LEGACY_KEYS=1` to exercise the current code with the legacy JWT-based keys. The suite restores the backup to a separate database, redeploys the matching baseline Console and functions, and repeats sign-in, booking read and hold placement.

## Operational checks

| Signal | Trigger | Host action |
| --- | --- | --- |
| Calendar read overdue | No successful read for 30 minutes, or a connection remains unread 30 minutes after setup | Verify availability directly and check the connection. |
| Calendar sync failed | The newest attempt failed to fetch or apply a calendar | Check the link and retry. Previous booking records remain until reconciled. |
| Calendar import incomplete | Transport returned a partial payload, the calendar failed validation, a prior future event disappeared, or a previous revision was found | Compare the calendar with the provider. Check any missing bookings before freeing dates. |
| Possible duplicate booking | Calendar and another source report the same listing and time range | Compare provider references. The warning leaves both records and occupancy intact. |
| Booking hold needs review | An unchecked active hold is at least two hours old, or an active hold expires within an hour | Check the original request and record its outcome before the hold expires. |
| Provider result needs review | An API confirmation is uncertain or has spent at least 15 minutes in approval processing | Verify state on the original provider. |
| Booking email update to review | Change, cancellation or refund notice awaits review | Reconcile against the original booking. |

The Console refreshes warnings each minute while the host is active, and after actions. Each warning links to the relevant screen. A service-only `operational_readiness` RPC returns aggregate counts and latest calendar attempt with no host identities or guest data. The existing calendar job emits a summary of successes, errors and deferrals. Scheduled external notifications and an off-console alert destination require a separate decision. The dashboard does not infer provider availability from a green calendar fetch.

## Verification and limits

- The browser and Edge Functions now use Supabase JS `2.119.2` and the locked npm audit includes the SDK. The disposable local rollback alone exercises the historical baseline SDK. Use the patched version for any hosted rollback. See the PR checks for current evidence. [Supabase SDK releases](https://github.com/supabase/supabase-js/releases) · [Published Auth SDK advisory](https://github.com/advisories/GHSA-8r88-6cj9-9fh5)
- **Isolated staging passed.** It exercised Airbnb overnight stays, Swimply hourly pool bookings, driveway independence, calendar directions, cleanup boundaries, missing events, partial payloads, provider revisions, retry, explicit cancellation, booking changes, duplicate forwarded messages and the host warnings. Two real local Auth accounts verified isolation. The old session was rejected by the Edge handler after sign-out and succeeded after reauthentication. A fresh deployment of the baseline code against the restored backup signed in and placed a hold.
- The exact hosted Supabase gateway, encryption through Vault, actual `pg_cron` invocation, email delivery, and live Airbnb, Swimply, Google and Cronofy behavior require gated verification. The runner invokes scheduled sync through the actual Edge handler with a synthetic scheduler secret. Its local Vault row is a substitute. Accounts auto-confirm without sending email.
- The measured local scope uses the same PostgreSQL transactional migrations, RLS policies and function source. Synthetic calendars replace remote responses, with aged timestamps for retry intervals. Desktop and mobile-width Chromium exercise the real Console. They do not establish latency or physical-device behavior for live providers.
- **No high-severity defect was reproduced in the exercised local flows.** Hosted authorization and recovery, real feed compatibility, calendar latency and outside confirmations still limit the pilot. Confirmed bookings on providers can overlap regardless of the result of a local capacity check.

## Pilot script

**Readiness decision.** Local staging can rehearse the full controlled workflow. A host-facing pilot needs separate staging approval, an invite-only authentication plan, provider read permission, and validation of the live calendar format and latency.

**Scope.** Start with 14 days, one opted-in host account, one operator account, one Airbnb whole-property listing, one linked Swimply pool and a local-only independent driveway. Optional calendar access is limited to one empty, dedicated listing calendar. Begin with synthetic fixtures. In the observation phase, allow at most ten real booking observations on those two listings within the next 30 days. Check the scope in the host dashboard before accepting any feed and stop importing if it exceeds the cap or includes unrelated listings. Use curated busy-only calendar data or verified host entry if that cap cannot be enforced with a provider feed. The host retains provider permissions and makes all real booking decisions there.

| Step | Action and evidence |
| --- | --- |
| 1. Consent | Obtain written, revocable consent from the host for the two listing references, busy intervals, data scope, source authorization, retention and access. Explain iCal delays, the limits of conflict detection, and the pause procedure. Keep customer names, emails, phone numbers, messages and payment details out of staging. Do not collect provider passwords or reuse personal calendars. |
| 2. Configuration | Use a separate staging project and hostname with invited accounts only. Set the property’s time zone, model the pool as a child of the house and keep the driveway detached. Document each provider’s instant-book setting. Replay a fixture overnight stay, hourly pool slot and cleaning buffer. Verify the related booking is refused in Everyspace and the driveway remains usable. |
| 3. Source comparison | Use authorized read-only calendar observations. Compare published dates with the host’s provider screens. Exercise create, change, explicit cancel and missing-event fixtures. Record attempt and receipt times, duplicate IDs, dropped notifications and recovery. Select compatible calendar formats and obtain permission before testing a shared calendar link on provider dashboards. |
| 4. Daily operation | During the trial the operator checks warnings and the host verifies each pending change, cancellation and hold on the provider. Record discrepancies without redistributing guest data. Flag any provider-side conflict as an external event to resolve with the host. |
| 5. Stop and restore | Stop scheduled reads and disable affected staging connections on a serious discrepancy. Revoke independent calendar grants and stop notification channels if used. Preserve a private snapshot of the candidate state before restoring the last consistent database and matching Console and function versions. Preserve the list of observations after the backup and reconcile them against the provider before reopening staging. The host continues in the provider dashboards. The local rehearsal intentionally restores the pre-upgrade snapshot. It does not replay post-backup operations automatically. |

**Exit criteria.** No unexplained cross-account access, silent release of occupancy, or conflicting managed confirmations. All tested local conflicts, cleanup boundaries and duplicate warnings match the expected outcomes. Every provider discrepancy is detected and reviewed during the daily operator check. All replay and failure fixtures recover on the next successful retry, and rollback restores the baseline account and reservation. Require latency evidence before attempting faster provider updates. A single outside double booking is investigated rather than interpreted as a failure of the local lock. Stop immediately for suspected tenant data exposure, a lost booking or an erroneous local confirmation.

**Privacy and retention.** Use busy intervals, coarse source timestamps and a pseudonymous test ID. Redact notices before upload. Access belongs to the pilot operator and host. Store tokens, calendar links and backups in staging secret storage with the smallest reasonable scope. Remove imported observations and destroy temporary backups within 30 days after the trial ends, except records the host explicitly requests to keep. Record revocation and confirm access has ended.

## Approval and budget

1. **Approve remote staging placement if a real host will use it.** Request one distinct Supabase Free project in the same region as production, using its own project ref, database, Auth settings, scheduler secret and service credentials. Request one approved access-controlled HTTPS preview for the matching Console. Begin with synthetic data and no production backup or secrets. Confirm an available free-project slot, the account owner and a `$0` service budget before provisioning. Free includes 500 MB of database size, and Supabase documents two active Free projects and 500,000 Edge invocations. One 15-minute scheduler would make at most 1,344 invocations over 14 days, plus manual reads and console activity. Actual quotas and preview costs must be checked before provisioning. [Supabase Free project limits](https://supabase.com/kb/faqs/platform/database-only-cost) · [Edge quotas](https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations)
2. **Approve a restricted sign-in path for the invited host.** The default hosted Supabase email service delivers only to the project team. Use a separately approved mail transport or an approved private account-enrollment and recovery process. A hosted provider must be checked for terms, privacy and price before it is used. [Supabase Auth email limits](https://supabase.com/docs/guides/auth/auth-smtp)
3. **Provide host consent and approve exact provider reads.** The host supplies the Airbnb export link for the approved listing through staging. Ask Swimply to confirm the dedicated-calendar use and partner intake path. If approved, authorize one Google Calendar test OAuth client with read-only access and a fixed HTTPS callback. Separately approve any Cronofy production plan, mailing service or hosting charge before activation. [Airbnb calendar connections](https://www.airbnb.com/help/article/99) · [Swimply authorization and cost details](SWIMPLY_READ_ONLY.md)

Local rehearsal incurred **$0 in new service charges**. The proposed external pilot is expected to fit free quotas if a separate free project, private HTTPS preview and approved sign-in path are available. Hosted pricing, any SMTP account and real provider access remain explicit approvals.

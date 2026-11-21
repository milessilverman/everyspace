# Hosted staging readiness

November 20, 2026 Pacific time. The connected Supabase organization is on the Free plan and has two active projects. Supabase allows two active Free projects across organizations an account owns or administers. The hosted rollout is blocked before project creation. To proceed, the owner must make a Free slot available without interrupting production, or provide staging-scoped access to an eligible Free organization with spare capacity. A new organization under the same limited owner does not free a slot. [Supabase billing FAQ](https://supabase.com/docs/guides/platform/billing-faq) · [Free project limits](https://supabase.com/docs/guides/platform/billing-on-supabase)

The local rehearsal and PR checks require no cloud deployment credentials. The staging builder creates static Console assets, a staging-only calendar schedule and a token-protected synthetic calendar fixture. It rejects the currently shipped project reference and keys other than publishable keys. [Isolated staging rehearsal](STAGING_PILOT.md)

## Verify the $0 setup before creating anything

| Component | Proposed setup | Account check |
| --- | --- | --- |
| Database and Edge Functions | One isolated Supabase Free project. Supabase publishes a 500 MB database limit and 500,000 Edge invocations on Free. | Verify a free slot and a $0 project quote for the chosen organization. Use staging-only credentials. |
| Login | Disable public sign-ups. Create two synthetic users with confirmed email addresses using the staging Auth admin API. Use individual generated passwords and issue the owner a synthetic login through an approved private channel. | Verify sign-up is disabled and no SMTP or external identity provider is needed. Never add a viewer to the Supabase organization merely to send mail. |
| Scheduling | Supabase Cron, pg_net and Vault on the isolated project. A 15-minute job invokes calendar sync about 2,880 times per 30 days. With two fixtures, allow about 5,760 additional fixture reads plus a small manual smoke-test allowance. | Confirm the project's Free plan and available quota. Keep the earnings and provider jobs disabled. |
| Private HTTPS preview | Cloudflare Workers static assets on a version URL protected by Cloudflare Access Free. Retain a single named viewer policy. | Provide access to an eligible separate Free account with permission to upload Worker versions and configure the Access policy. Confirm the signed-out route is denied before attaching synthetic login credentials. |

Cloudflare publishes no charge for static asset requests and offers an Access Free tier. Supabase's default Edge Function hostname rewrites HTML responses as plain text. Verify the Supabase Free slot, Cloudflare account access and total cost before publishing. This pass prepared the deployment artifacts locally. [Supabase Edge quotas](https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations) · [Supabase Cron](https://supabase.com/docs/guides/cron) · [Supabase Auth email limits](https://supabase.com/docs/guides/auth/auth-smtp) · [Edge Function HTML limits](https://supabase.com/docs/guides/functions/limits) · [Cloudflare static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) · [Cloudflare Access for Worker versions](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) · [Cloudflare Zero Trust pricing](https://www.cloudflare.com/plans/zero-trust-services/)

## Deploy to the verified staging target

1. Create an isolated Supabase Free project after verifying the slot and quote. Confirm the new project reference, apply the repository migrations over its staging connection, and check the Data API grants. Start with an empty database. The current migrations include explicit grants for new projects that do not expose tables automatically. [Supabase Data API change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
2. Set up staging Auth with sign-ups disabled, the protected preview origin as the Site URL, and synthetic users created through the Auth admin API. Keep the Supabase public key and service key separate. Deploy `booking-guard`, `booking-email`, `calendar-feed`, `calendar-sync` and `channel-reservations` using the verified staging project reference. Override `verify_jwt` only for calendar sync's staging deployment so the scheduler can call it without a user JWT. The handler authenticates each request with its Vault-backed scheduler secret or a verified Auth session. The other deploys use the checked-in gateway settings. [Supabase Auth headers](https://supabase.com/docs/guides/functions/auth-headers) · [Supabase scheduling](https://supabase.com/docs/guides/functions/schedule-functions)
3. Build the preview and schedule locally. Supply only the new project's publishable API key for this step.

   ```sh
   export STAGING_PROJECT_REF='your-staging-project-reference'
   export STAGING_PUBLISHABLE_KEY='your-staging-publishable-key'
   npm run staging:package --prefix platform -- /tmp/everyspace-preview
   ```

4. In the approved Cloudflare Free account, configure Access to protect version URLs before upload. For a dedicated account, use an `all_preview_workers` destination with an allow policy for the owner. Upload with `wrangler versions upload` from the output directory. The default Worker route is disabled. Record the actual private HTTPS version URL. Check anonymous and wrong-identity denial and owner access for both the Console and its assets. [Cloudflare version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/) · [Cloudflare Access policy](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
5. Use the generated `fixtures` directory as a separate Supabase CLI workdir. Deploy only `staging-calendar-fixture` from it to the new project. Set the staging project secret `STAGING_FIXTURE_TOKEN` to a high-entropy random value. Allowlist only the staging project hostname through `CALENDAR_FEED_HOST_ALLOWLIST`. Seed synthetic feed links using the fixture routes `/functions/v1/staging-calendar-fixture/<token>/house` and `/pool` under that same base. Run the generated `calendar-schedule.sql` on the verified staging connection. The package schedules only calendar sync.

## Hosted acceptance and rollback

| Evidence to capture | Acceptance |
| --- | --- |
| Preview and Auth | Access denies unsigned and unauthorized viewers. The enrolled operator uses two synthetic accounts in turn and verifies no cross-account records or resident dialog state. Signup is disabled. Signed-out sessions cannot act. The service-only readiness RPC is denied to hosts. |
| Calendar and inventory | A July 14, 2037 overnight house event and July 16 hourly pool event are imported. A pool hold overlapping the house fails, an independent driveway hold succeeds, and the pool's 30-minute buffer blocks a 17:15 request until 17:30 local time. Calendar exports exclude guest data. |
| Native schedule and alerts | Record an actual 15-minute Cron run and matching Edge log. The job updates the fixture calendars and operating counts. Exercise `partial`, `unavailable`, `missing`, `pool-older`, `pool-changed`, and `pool-cancelled`. Confirm earlier occupancy survives failures and warnings clear after a successful complete read. Explicit newer cancellation is reflected. |
| Rollback | Capture a logical backup and exact protected app version. Rehearse restoration with synthetic data while the job is stopped. Resume only after checking Auth, RLS, existing bookings, hold placement and fixture sync. Keep the patched SDK in the approved hosted rollback bundle. |

Attach workflow and service evidence using timestamps and status codes. Keep real provider credentials, OAuth clients, billing and provider approval transports out of the project.

## Next owner actions

1. Make a Supabase Free slot available or grant access to an eligible Free organization with spare capacity. Confirm the organization for the separate staging project.
2. Connect a Cloudflare Free account for an Access-protected Worker version and specify the one approved viewer identity. Authorize access through the account connection rather than sharing credentials in chat.
3. After the private URL exists, review the proposed Google scope, callback URLs and consent process. This is a separate decision. [Swimply Calendar test proposal](SWIMPLY_READ_ONLY.md#dedicated-google-calendar-test-proposal)

# Hosted staging readiness

The existing Supabase Free organization has both slots occupied by Everyspace and StreetForge. Supabase counts active projects across Free organizations an identity owns or administers. Use a separate eligible identity and a Free organization with a spare slot. Keep the current Supabase plugin connection and both existing projects outside the staging rollout. [Supabase billing FAQ](https://supabase.com/docs/guides/platform/billing-faq) · [Free project limits](https://supabase.com/docs/guides/platform/billing-on-supabase)

The local rehearsal and PR checks require no cloud deployment credentials. The staging builder creates static Console assets, a staging-only calendar schedule and a token-protected synthetic calendar fixture. It also builds a separate Access probe with the same asset routes, a random challenge and no backend connection. The builder rejects the currently shipped project reference and accepts only a publishable API key. [Isolated staging rehearsal](STAGING_PILOT.md)

## Verify the $0 setup before creating anything

| Component | Proposed setup | Account check |
| --- | --- | --- |
| Database and Edge Functions | One isolated Supabase Free project. Supabase publishes a 500 MB database limit and 500,000 Edge invocations on Free. | Verify a free slot and a $0 project quote for the chosen organization. Use staging-only credentials. |
| Login | Disable public sign-ups. Create two synthetic users with confirmed email addresses using the staging Auth admin API. Use individual generated passwords and issue the owner a synthetic login through an approved private channel. | Verify sign-up is disabled and password login works within Supabase Auth Free without an SMTP service. |
| Scheduling | Supabase Cron, pg_net and Vault on the isolated project. At one run per 15 minutes with two fixture reads each, budget about 8,640 Edge invocations per 30 days plus manual checks. | Confirm the project's Free plan and available quota. Enable only the staging calendar job. |
| Private HTTPS preview | Cloudflare Workers static assets on a version URL protected by Cloudflare Access Free. Access allows up to 50 users on Free. The Workers Free tier allows 100,000 script requests per day, 20,000 static assets per version and 25 MiB per asset. | Verify a dedicated account on Workers Free and Access Free. Use a single named viewer. Test denial before uploading the Console. |

Published plans put the expected total at **$0 per month** for this setup. The preview has only static assets, which Cloudflare serves at no charge. It uses the included HTTPS hostname and has no Worker script, domain registration or storage binding. Supabase's default Edge Function hostname rewrites HTML responses as plain text. Verify the Supabase slot and project quote, and both Cloudflare Free entitlements, before provisioning. The connected account blocks hosted verification at project creation. [Supabase Edge quotas](https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations) · [Supabase Cron](https://supabase.com/docs/guides/cron) · [Supabase Auth email limits](https://supabase.com/docs/guides/auth/auth-smtp) · [Edge Function HTML limits](https://supabase.com/docs/guides/functions/limits) · [Cloudflare static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) · [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Cloudflare Zero Trust pricing](https://www.cloudflare.com/plans/zero-trust-services/)

Prefer an already enrolled Cloudflare Zero Trust Free account. Cloudflare asks for payment details during new Free enrollment. Any account enrollment that requires payment details is an owner authorization step. [Cloudflare Zero Trust enrollment](https://developers.cloudflare.com/cloudflare-one/setup/)

## Deploy to the verified staging target

1. Use the named staging connection to list the organizations and projects it can reach. Confirm the owner-authorized staging organization, its Free plan, an unused slot and a $0 project quote. Keep the connection limited to the staging organization. Create the isolated project there. Confirm its new project reference, apply the repository migrations over its staging connection, and check the Data API grants. Start with an empty database. The current migrations include explicit grants for new projects that do not expose tables automatically. [Supabase project cost confirmation](https://supabase.com/docs/guides/ai-tools/mcp#cost-confirmation) · [Supabase Data API change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
2. Disable public sign-ups and create synthetic users through the staging Auth admin API. Keep the Supabase publishable and service-role keys separate. Deploy `booking-guard`, `booking-email`, `calendar-feed`, `calendar-sync` and `channel-reservations` using the verified staging project reference. Override `verify_jwt` only for calendar sync's staging deployment so the scheduler can call it without a user JWT. The handler authenticates each request with its Vault-backed scheduler secret or a verified Auth session. The other deploys use the checked-in gateway settings. [Supabase Auth headers](https://supabase.com/docs/guides/functions/auth-headers) · [Supabase scheduling](https://supabase.com/docs/guides/functions/schedule-functions)
3. Build the preview and schedule locally. Supply only the new project's publishable API key for this step.

   ```sh
   export STAGING_PROJECT_REF='your-staging-project-reference'
   export STAGING_PUBLISHABLE_KEY='your-staging-publishable-key'
   npm run staging:package --prefix platform -- /tmp/everyspace-preview
   ```

4. In the dedicated Cloudflare Free account, configure Access to protect version URLs before upload. Use an `all_preview_workers` destination with an Allow policy for the owner's exact email and a temporary Service Auth policy for the verifier. Use Cloudflare Access's one-time PIN for the named viewer. The package disables the default Worker route. Cloudflare documents Access coverage for static assets. [Cloudflare version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/) · [Cloudflare Access policy](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) · [Cloudflare one-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/) · [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

   Upload only the inert probe first, using `wrangler versions upload --config /tmp/everyspace-preview/access-probe/wrangler.jsonc`. Set `STAGING_PREVIEW_URL` to the returned URL, `STAGING_ACCESS_URL` to the dedicated Access origin and load `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` from the temporary token into the operator environment.

   ```sh
   STAGING_PROBE_CHALLENGE="$(cat /tmp/everyspace-preview/access-probe/challenge.txt)" \
     npm run staging:verify-access --prefix platform
   ```

   After the probe passes, upload the Console with `wrangler versions upload --config /tmp/everyspace-preview/wrangler.jsonc`. Set `STAGING_PREVIEW_URL` to the Console version's URL and verify again with `STAGING_PROJECT_REF` and the temporary token. Clear `STAGING_PROBE_CHALLENGE` for this run. The check requires anonymous denial, a matching authenticated response and `private, no-store` on each route. If either check fails, disable staging version URLs. Verify the named viewer can sign in and an unlisted identity is denied, then revoke the temporary token and set the approved Console origin as the staging Auth Site URL. Use only that protected URL for access and acceptance testing.
5. Use the generated `fixtures` directory as a separate Supabase CLI workdir. Deploy only `staging-calendar-fixture` from it to the new project. Set the staging project secret `STAGING_FIXTURE_TOKEN` to a high-entropy random value. Allowlist only the staging project hostname through `CALENDAR_FEED_HOST_ALLOWLIST`. Seed synthetic feed links using the fixture routes `/functions/v1/staging-calendar-fixture/<token>/house` and `/pool` under that same base. Run the generated `calendar-schedule.sql` on the verified staging connection. The package schedules only calendar sync.

## Hosted acceptance and rollback

| Evidence to capture | Acceptance |
| --- | --- |
| Preview and Auth | Access denies unsigned and unauthorized viewers. The enrolled operator uses two synthetic accounts in turn and verifies no cross-account records or resident dialog state. Signup is disabled. Signed-out sessions cannot act. The service-only readiness RPC is denied to hosts. |
| Calendar and inventory | A July 14, 2037 overnight house event and July 16 hourly pool event are imported. A pool hold overlapping the house fails, an independent driveway hold succeeds, and the pool's 30-minute buffer blocks a 17:15 request until 17:30 local time. Calendar exports exclude guest data. |
| Native schedule and alerts | Record an actual 15-minute Cron run and matching Edge log. The job updates the fixture calendars and operating counts. Start with `pool`. Exercise `partial`, `unavailable`, `missing`, `pool-older` and `pool-ambiguous-cancel`, restoring `pool` after each failure. Earlier bookings remain occupied until a complete read resolves the warning. Then try `pool-changed` followed by `pool-cancelled`. Confirm that a newer cancellation frees the recorded time. Verify that saving an updated link refreshes only that connection. |
| Rollback | Capture a logical backup and exact protected app version. Rehearse restoration with synthetic data while the job is stopped. Resume only after checking Auth, RLS, existing bookings, hold placement and fixture sync. Keep the patched SDK in the approved hosted rollback bundle. |

Attach workflow and service evidence using timestamps and status codes. Keep real provider credentials, OAuth clients, billing and provider approval transports out of the project.

## Next owner action

Authorize the prepared Supabase connection in local Codex. The launcher adds `everyspace-staging-supabase` at `https://mcp.supabase.com/mcp` for that session. It uses the official browser OAuth flow under the new server name, alongside the existing plugin and local configuration.

1. From the draft branch in a local checkout, run `bash platform/staging/codex-supabase.sh authorize` on the computer that will run Codex.
2. In the browser prompt, sign in with the separate staging identity and select only its Free organization with an unused project slot. If the prompt shows the current account, open the authorization page in a separate browser profile and select the staging account there.
3. The launcher opens local Codex with the named connection. Continue the staging work in that session so Codex can verify the authorized organization, available slot, and $0 quote. Use `bash platform/staging/codex-supabase.sh open` to reopen it on the same computer. [Codex MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) · [Supabase MCP setup](https://supabase.com/docs/guides/ai-tools/mcp) · [Supabase organizations](https://supabase.com/dashboard/organizations)

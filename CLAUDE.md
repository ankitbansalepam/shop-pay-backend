# Shop Pay Backend

## Scope
This is a Node 20+ Express POC connecting BigCommerce checkout to Shopify Shop Pay.

## Token-efficient workflow
- Start from the named route, function, failing request, or command.
- Read only the nearby code needed to identify the controlling behavior.
- Search only this repository; do not scan checkout-js or Cornerstone unless the task crosses that boundary.
- Make the smallest focused change and preserve unrelated user changes.
- Run the narrowest relevant check immediately after editing.
- Keep responses concise: changed files, validation, and blockers.

## Ownership
- Routes and Shopify GraphQL mutations are in `server.js`.
- Keep Shopify credentials and webhook secrets server-side.
- Preserve unique `sourceIdentifier` values, server-side payment request storage, submit idempotency, and webhook HMAC verification.
- Never print, commit, or expose `.env` values.

## Commands
- `npm start` runs the server.
- `npm run dev` runs the watch mode.
- `GET /health` is the cheapest health check.

## Shop Pay implementation context

- The active backend is `C:\Project\shop-pay-backend`; do not use the `repo-install-check` copy for runtime.
- Production runs at `https://shop-pay-backend.vercel.app` (Vercel team `shop-pay`), the default backend URL in checkout's `shopPayConfig.ts`. Deploy with `vercel --prod` from this folder (a folder upload, not git); `.vercelignore` keeps `.env`, `data/`, and logs out.
- Vercel env vars are Sensitive and cannot be read back. To check CORS, probe `OPTIONS /shop-pay/session` with each storefront `Origin`. For a new storefront domain, add it to Vercel `ALLOWED_ORIGIN`, then `vercel redeploy`.
- Logs: `vercel logs shop-pay-backend.vercel.app --since 30m --expand`. A `POST /shop-pay/session` without a following `POST /shop-pay/submit` means Shopify rejected the payment inside the popup before asking us to submit.
- Active storefront: `https://shoppaystore.mybigcommerce.com` (store hash `ocqei08gqj`). Shopify store: `mynewstore-9969.myshopify.com`.
- The local `.env` `STOREFRONT_API_TOKEN` returns `Channel not found` (stale); the working token is only in Vercel env. `ADMIN_API_TOKEN` and the BigCommerce credentials in `.env` work for diagnostics.
- Sessions are stored in Upstash Redis (`upstash-kv-cobalt-drawer`, iad1, connected via Vercel Marketplace; env `KV_REST_API_URL`/`KV_REST_API_TOKEN`), keyed `shop-pay:session:{sourceIdentifier}` plus `shop-pay:order:{bcOrderId}`, 7-day TTL. Without those env vars `sessionStore.js` falls back to a JSON file (`SESSION_STORE_PATH`), which suits only a single local process. The startup log says which store is in use.
- BigCommerce cart deletion occurs only after the authenticated confirmation endpoint successfully retrieves order data.
- The `orders/create` webhook is created in Shopify Admin (Settings → Notifications → Webhooks) for `https://shop-pay-backend.vercel.app/webhooks/shopify/orders`, and signed with the key shown on that page, stored as Vercel `SHOPIFY_WEBHOOK_SECRET`. Don't create it through the Admin API: the Shop channel app doesn't expose the secret that signs app-created webhooks, so they always fail HMAC (401).
- The webhook is a safety net (SHP-17): if checkout never calls `/shop-pay/complete` (tab closed after paying), the webhook creates the BigCommerce order through the same `completeWithShopifyOrder` step and per-session lock, so a payment still creates exactly one order. For an already completed session it only makes sure the order is marked paid.
- Health (SHP-20): `GET /health/webhooks` with `Authorization: Bearer <CRON_SECRET>` reports verified deliveries, HMAC rejections, failures, and paid Shopify orders without a BigCommerce order after 10 minutes (submitted payments are tracked in the Redis sorted set `shop-pay:pending`). A Vercel cron runs it daily at 09:00 UTC (the Hobby plan allows only daily crons) and logs `[health] webhook problems` on failure. `CRON_SECRET` is a random Sensitive value; set your own with `vercel env add` to call the endpoint by hand.
- `/webhooks/shopify/orders` verifies HMAC and ignores duplicate deliveries for the same Shopify order. Set a real `SHOPIFY_WEBHOOK_SECRET` before enabling webhook processing; an empty value intentionally rejects webhook requests.
- `/shop-pay/submit` only submits the payment. `/shop-pay/complete` creates the BigCommerce order once the Admin API shows a PAID/AUTHORIZED Shopify order with the same `sourceIdentifier` and a matching total; it answers 202 while the order is pending. Never create the BigCommerce order at submit: the payment can still fail afterwards.

Do not change Shopify API versions, GraphQL fields, or payment-flow semantics without checking the relevant Shopify contract.

## Shop Pay open work

Only the items under "Remaining work" in `.claude/skills/shop-pay-integration/SKILL.md` are still open (real ATP API, Apigee, gateway contract, go-live switches, and a few known gaps). Everything else in the estimation sheet is done or out of scope.

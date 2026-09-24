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
- `/webhooks/shopify/orders` verifies HMAC and ignores duplicate deliveries for the same Shopify order. Set a real `SHOPIFY_WEBHOOK_SECRET` before enabling webhook processing; an empty value intentionally rejects webhook requests.
- Current flow creates the BigCommerce order during `/shop-pay/submit` and uses the Shopify webhook for reconciliation. Do not describe this as fully webhook-created order flow unless that contract is explicitly changed.

Do not change Shopify API versions, GraphQL fields, or payment-flow semantics without checking the relevant Shopify contract.

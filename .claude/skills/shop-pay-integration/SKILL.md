---
name: shop-pay-integration
description: "Use when working on Shop Pay checkout, session conflicts, CORS, Vercel deploys, stale bundles, declined Shop Pay payments, button placement, order confirmation redirects, webhook reconciliation, the narrated demo video, or checkout build errors such as polyfill, manifest, and card-validator failures."
---

# Shop Pay Integration Workflow

## Token-efficient execution

- Start from the exact user error, URL, file, route, or command; do not scan all repositories.
- Read only the owning implementation and one nearby test/call site before editing.
- State one local hypothesis and one discriminating validation check, then act.
- Use parallel reads for independent files and avoid pasting generated bundles into context.
- Inspect generated `build`/`dist` files only with targeted string checks after source changes.
- Run the narrowest validation first; do not run broad tests unless the focused check requires it.
- Keep progress updates and final reports concise; record durable facts here instead of rediscovering them.

## Repository scope

- Use only the primary repositories: `C:\Project\checkout-js`, `C:\Project\shop-pay-backend`, and `C:\Project\Cornorstone\Cornerstone-6.21.0`.
- Do not use `C:\Project\repo-install-check` for active builds or runtime.
- Keep Shopify credentials and webhook secrets server-side. Never print `.env` values (print key names only, e.g. `sed -E 's/=.*/=<redacted>/' .env`).

## Runtime map

- Storefront: `https://shoppaystore.mybigcommerce.com` (store hash `ocqei08gqj`). The loader URL is set in the BigCommerce control panel, not in the Cornerstone theme.
- Checkout: `https://checkout-js-weld.vercel.app/auto-loader.js`. A push to `master` on `github.com/ankitbansalepam/checkout-js` auto-deploys to Vercel production (team `shop-pay`, project `checkout-js`). `vercel ls checkout-js` shows status.
- Backend: `https://shop-pay-backend.vercel.app`, deployed with `vercel --prod` from `C:\Project\shop-pay-backend` (folder upload, not git). Vercel env vars are Sensitive and cannot be read back; probe `OPTIONS /shop-pay/session` with an `Origin` header to test `ALLOWED_ORIGIN`.
- Shopify: `mynewstore-9969.myshopify.com`, Shop Pay Commerce Component plan, Shopify Payments in test mode.
- The local backend `.env` `STOREFRONT_API_TOKEN` returns `Channel not found` (stale); the Vercel env holds the working token. `ADMIN_API_TOKEN` and the BigCommerce credentials in the local `.env` work.

## Required checkout flow

1. Shop Pay button click creates a session; never create sessions during render or mount.
2. Each new attempt uses a unique `sourceIdentifier` (`bc-{cartId}-{uuid}`). Reuse the idempotency key only inside that attempt.
3. Pay now (`paymentconfirmationrequested`) only submits the payment. On `paymentcomplete`, `completeShopPaySession` calls `/shop-pay/complete`, which returns `{ bcOrderId, confirmationToken }` once Shopify has a PAID order for the session (202 while pending; the client retries about 6 × 2s). Never create the BigCommerce order at submit: a payment can still fail afterwards (order 115 was left paid but uncharged).
4. One backend session per click (`backendSessionRequest ??=`); the backend also returns the existing Shopify session for a repeated `sourceIdentifier`.
5. The confirmation URL must remain `/checkout/order-confirmation?orderId=...&shopPay=1&confirmationToken=...`.
6. Use in-app `history.replaceState` plus `popstate` and render `ShopPayOrderConfirmation` from `CheckoutPage`; a full native route request can 302 to cart for externally created orders.
7. Delete the BigCommerce cart only after the authenticated confirmation endpoint retrieves the order.

## Button placement

- `CheckoutHeader` renders `placement="top"`; `PaymentForm` renders `placement="payment"`. Exactly one shows.
- Top for signed-in shoppers (`getCustomer().isGuest === false`, not latched, so signing in mid-checkout moves it up), or when billing address and shipping method were known when checkout loaded. Otherwise the payment methods.
- A signed-in shopper can open Shop Pay before checkout has a consignment; `onShippingAddressChanged` then creates one with `updateShippingAddress` before re-selecting a shipping option.
- Readiness is recorded once per cart id in `ShopPayCheckoutControl` (`initialReadinessByCartId`); tests call `resetShopPayPlacement()` in `beforeEach`.
- Reloading after entering addresses mid-checkout shows the top button, because BigCommerce kept the addresses.

## Payment request consistency

- Shopify declines the payment inside the popup, before `paymentconfirmationrequested`, if the payment request no longer matches the delivery method shown in Shop Pay.
- `shippingaddresschanged` updates the BigCommerce consignment, which clears its selected shipping option. `onShippingAddressChanged` re-selects one (Shop Pay's current shipping line code, then the previous option, then recommended/first) before rebuilding the payment request.
- `deliverymethodchanged` selects the same option in BigCommerce (`onDeliveryMethodChanged`), then rebuilds the payment request; without it BigCommerce orders get the wrong shipping.
- `ShopPayButton` keeps a `latest` checkout state (cart, consignments, coupons, tax) that every handler updates, and rebuilds every payment request from it.
- `/shop-pay/submit` rejects with 422 unless the submitted total equals BigCommerce's `v3/checkouts/{cartId}` `grand_total` (cart incl. tax + selected shipping incl. tax), so the checkout must always have the Shop Pay shipping option selected.
- Backend rules live in `validation.js`, tested with `npm test` (`node --test`).

## Scheduled (truck) delivery

- Products with custom field `delivery_type = scheduled` (test products 112, 113) make the cart scheduled. The backend decides (`POST /delivery/options`, product lookup cached 5 min); checkout-js has no product custom fields.
- Services are BigCommerce shipping methods White Glove Delivery ($80) and Green Glove Delivery ($99) in the US zone (methods 3, 4); names configurable via backend `SCHEDULED_DELIVERY_SERVICES`. `filterShippingOptionsForCart` shows them only for scheduled carts.
- Dates: mock ATP `getAvailableDeliveryDates()` in backend `delivery.js`; replace with the real ATP API (SHP-15).
- Checkout: `ScheduledDeliveryFields` in the shipping footer; state in `scheduledDelivery.ts` (module store + sessionStorage per cart). Continue is disabled until a date is chosen.
- Shop Pay: no top button for scheduled carts; payment step shows a note until a date is chosen; the popup gets only the chosen method with min/max delivery date; submit rejects scheduled carts without a scheduled service and available date; the order gets staff notes + customer message.
- Only Shop Pay orders record the date; other payment methods and multi-address shipping don't yet.

## Backend safeguards

- Sessions are stored in Upstash Redis (`upstash-kv-cobalt-drawer`, iad1, connected via Vercel Marketplace; env `KV_REST_API_URL`/`KV_REST_API_TOKEN`), keyed `shop-pay:session:{sourceIdentifier}` plus `shop-pay:order:{bcOrderId}`, 7-day TTL. Without those env vars `sessionStore.js` falls back to a JSON file (`SESSION_STORE_PATH`), which suits only a single local process. The startup log says which store is in use.
- Verify webhook HMAC using the raw request body and set a real `SHOPIFY_WEBHOOK_SECRET` before enabling webhook processing.
- Treat duplicate Shopify order webhooks as idempotent.
- The `orders/create` webhook is created in Shopify Admin (Settings → Notifications → Webhooks) for `https://shop-pay-backend.vercel.app/webhooks/shopify/orders`, and signed with the key shown on that page, stored as Vercel `SHOPIFY_WEBHOOK_SECRET`. Don't create it through the Admin API: the Shop channel app doesn't expose the secret that signs app-created webhooks, so they always fail HMAC (401).
- The webhook is a safety net (SHP-17): if checkout never calls `/shop-pay/complete` (tab closed after paying), the webhook creates the BigCommerce order through the same `completeWithShopifyOrder` step and per-session lock, so a payment still creates exactly one order. For an already completed session it only makes sure the order is marked paid.
- Health (SHP-20): `GET /health/webhooks` with `Authorization: Bearer <CRON_SECRET>` reports verified deliveries, HMAC rejections, failures, and paid Shopify orders without a BigCommerce order after 10 minutes (submitted payments are tracked in the Redis sorted set `shop-pay:pending`). A Vercel cron runs it daily at 09:00 UTC (the Hobby plan allows only daily crons) and logs `[health] webhook problems` on failure. `CRON_SECRET` is a random Sensitive value; set your own with `vercel env add` to call the endpoint by hand.
- `/shop-pay/complete` confirms payment by finding the Shopify order whose `sourceIdentifier` matches, through the Admin API (`ADMIN_API_TOKEN`), and checks it is PAID/AUTHORIZED with a total within one cent. Only then does it create the BigCommerce order (or reconcile a pre-existing `bcOrderId`). The webhook creates the order instead if checkout never calls `/shop-pay/complete`.

## Diagnosing a failed Shop Pay payment

1. Backend logs: `vercel logs shop-pay-backend.vercel.app --since 30m` (add `--expand` for console output). A `POST /shop-pay/session` with no following `POST /shop-pay/submit` means Shopify rejected the payment inside the popup; our backend was never asked to submit.
2. Shopify orders: query the Admin GraphQL `orders(first:5, reverse:true)` with `ADMIN_API_TOKEN` and compare `sourceIdentifier`, `displayFinancialStatus`, and totals. A paid Shopify order with a matching `bc-{cartId}-…` means the attempt succeeded.
3. BigCommerce orders: `v2/orders?sort=id:desc&limit=5` shows whether `/shop-pay/submit` created the order, with its shipping and totals.
4. Only the popup's own console (right-click in the popup → Inspect) shows Shopify's rejection reason; the checkout page console only shows SDK events.
5. "There was an issue with your selected payment method" with the saved card listed but not selected: card selection is Shopify-owned and cannot be preselected from checkout-js. Clicking the card before Pay now works. If it persists, re-add the card in test mode or raise it with Shopify.

## Troubleshooting checklist

- CORS error: test `OPTIONS /shop-pay/session` with the storefront `Origin`; add a missing origin to Vercel `ALLOWED_ORIGIN`, then `vercel redeploy`.
- `409 Conflict`: inspect `sourceIdentifier`; a reused `bc-{cartId}` means an old persisted session is being reused.
- Stale bundle: fetch `auto-loader.js`, grep the `checkout-*.js` chunk it lists for a distinctive identifier from the change, then hard-refresh (Ctrl+Shift+R).
- `'checkout' property is not available in window`: the loader embedded an empty manifest; check the `js:[...]` list in `auto-loader.js` is non-empty.
- Confirmation 302/404: preserve the exact checkout confirmation URL and in-app navigation behavior.
- Polyfill/manifest/card-validator errors: run the primary build, inspect the first TypeScript error, and fix the owning source before changing generated output.

## Validation commands

- `npx jest packages/shop-pay-integration/src packages/utility/src/navigateToOrderConfirmation.test.ts --runInBand`
- `npx nx run core:build --skip-nx-cache`
- Backend: `node --check server.js` and `GET https://shop-pay-backend.vercel.app/health`

## Demo video

- Recorder: `scripts/record-shop-pay-demo.mjs`. It runs a guest checkout on shoppaystore with Playwright: add product 94 to the cart, enter email, shipping address and method, show Shop Pay in the payment methods, open the popup, then the in-app confirmation.
- Narration: Windows `System.Speech` (voice `Microsoft Zira Desktop`) generates one clip per step before recording; each step's caption is held for its clip's length.
- ffmpeg composes `shop-pay-demo.mp4`: the checkout video, cut to the popup video while it is open, with narration clips placed at each step's time from `timeline.json`. ffmpeg is not installed system-wide; set `FFMPEG_PATH` (e.g. from `npm i ffmpeg-static` in a scratch folder).
- Run from checkout-js: `$env:FFMPEG_PATH='<path>\ffmpeg.exe'; node scripts/record-shop-pay-demo.mjs`. Overrides: `SHOP_PAY_DEMO_STORE_URL`, `SHOP_PAY_DEMO_PRODUCT_ID`, `SHOP_PAY_DEMO_EMAIL`, `SHOP_PAY_DEMO_VOICE`, `SHOP_PAY_DEMO_POPUP_TIMEOUT_MS` (default 5 minutes).
- The Shop Pay sign-in (SMS code) and Pay now are manual; complete them in the headed browser.
- Output: `packages/test-framework/videos/shop-pay-demo/` (gitignored), with the MP4, raw `.webm` files, `timeline.json`, and `narration/*.wav`.
- Form gotchas: select country and state before filling other address fields (changing the country clears them); click `label[for="sameAsBilling"]`, not the hidden checkbox; wait for a `:checked` shipping radio, because BigCommerce ticks it only after the server round-trip.

## Backlog status

- Core MVP flow is implemented: Shop Pay session, payment request, address/delivery updates, discount updates, submit, BigCommerce order creation, confirmation display, and delayed cart cleanup.
- Remaining MVP work: ATP eligibility checks and ATP delivery time slots (SHP-06, SHP-15, SHP-25).
- Partially implemented: webhook setup/order reconciliation (listener and duplicate protection exist; the BigCommerce order is created by `/shop-pay/complete` after Shopify reports it paid, not by the webhook). Session persistence (SHP-12) is done: Upstash Redis.
- Out of scope per the sheet: CI/CD, reconciliation job, fulfillment sync/monitoring, fraud integration, OmniTracks, truck eligibility extension, and Google address correction.

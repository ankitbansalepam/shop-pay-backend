# Shop Pay Wallet + BigCommerce Custom Checkout — Integration Guide

This documents how Shop Pay Wallet was wired into the BigCommerce custom checkout
(`checkout-js`) via a small Node backend (`shop-pay-backend`), end to end.
For a step-by-step setup guide, see `checkout-js/docs/shop-pay-implementation.md`.

## Architecture overview

```
Browser (BigCommerce custom checkout, checkout-js)
        │  1. renders Shop Pay button, loads Shop Pay JS SDK
        ▼
Shop Pay popup (Shopify-hosted)
        │  2. fires session/shipping/payment events
        ▼
shop-pay-backend (Node/Express on Vercel)
        │  3. calls Shopify Storefront API (session create/submit)
        │  4. creates + reconciles the BigCommerce order (v2 Orders API)
        ▼
Shopify (payment processing)  +  BigCommerce (order of record)
```

- **checkout-js**: renders the button, builds the payment request from the BigCommerce
  cart/consignments, and relays Shop Pay SDK events to the backend.
- **shop-pay-backend**: the only place that holds Shopify Storefront/webhook secrets and
  the BigCommerce API token. Never expose these to the browser.
- **BigCommerce**: source of truth for cart/shipping. An order is created via the v2
  Orders API only after Shopify confirms the Shop Pay payment.

## Step 1 — Configure Shopify

1. Create a Shopify store, complete Shopify Payments sign-up, keep test mode on.
   Shop Pay Wallet requires a **new** store created through the dedicated Shop Pay
   Wallet enterprise signup URL:
   `https://admin.shopify.com/signup?signup_types%5B%5D=spcc_plan&signup_page=https://shopify.dev/docs/api/commerce-components/pay`
   (linked from the [Get started with Shop Pay Wallet](https://shopify.dev/docs/api/commerce-components/pay)
   docs) — an existing/regular Shopify store cannot be enabled for the Shop Pay Wallet
   API. The store created for this integration is `mynewstore-9969.myshopify.com`.
2. Install the Shop sales channel and record the **Shop ID** and **Shop Pay Client ID**.
3. Add the checkout origin (`https://shoppaystore.mybigcommerce.com`) to the Shop Pay
   domain allow list.
4. Create a Storefront API access token (`STOREFRONT_API_TOKEN`) with Shop Pay Payment
   Request scopes.
5. Create a webhook subscription for `ORDERS_CREATE` (see Step 5) and record the
   webhook secret.

## Step 2 — Backend (`shop-pay-backend/server.js`)

Environment variables (`.env`, never committed/exposed):

| Variable | Purpose |
| --- | --- |
| `SHOP_DOMAIN` | `your-store.myshopify.com` |
| `SHOP_ID` | Shopify numeric shop id |
| `STOREFRONT_API_TOKEN` | Storefront API token for Shop Pay mutations |
| `SHOPIFY_WEBHOOK_SECRET` | HMAC secret for `ORDERS_CREATE` webhook |
| `SHOPIFY_API_VERSION` | Storefront API version (e.g. `2025-07`) |
| `BIGCOMMERCE_STORE_HASH` / `BIGCOMMERCE_ACCESS_TOKEN` | BigCommerce v2/v3 API auth |
| `BIGCOMMERCE_PAID_STATUS_ID` | Status id to set once payment is confirmed (`11` = Awaiting Fulfillment) |
| `BIGCOMMERCE_CREATE_ORDER` | `true` to enable BigCommerce order creation |
| `ALLOWED_ORIGIN` | Comma-separated CORS allowlist (the checkout origin) |
| `PORT` | Local backend port (`8787`); ignored on Vercel |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis session store, added by the Vercel Marketplace integration (`UPSTASH_REDIS_REST_URL`/`_TOKEN` also work) |
| `SESSION_STORE_PATH` | Local fallback session file when Redis isn't configured (default `data/shop-pay-sessions.json`) |

Routes:

- `POST /shop-pay/session` — builds a `ShopPayPaymentRequestInput` from the BigCommerce
  cart and calls `shopPayPaymentRequestSessionCreate` on the Storefront API. Stores the
  session (`token`, `paymentRequest`, `sourceIdentifier`, a random `confirmationToken`) in
  `orderMap`, persisted to `SESSION_STORE_PATH`, and returns
  `{ token, checkoutUrl, sourceIdentifier }` to the browser. The browser sends a unique
  `sourceIdentifier` per attempt (`bc-{cartId}-{uuid}`).
- `POST /shop-pay/submit` — called when the buyer clicks **Pay now**. Merges the final
  payment request (shipping lines, totals, payment method) sent by the frontend into the
  stored request, calls `shopPayPaymentRequestSessionSubmit` with a unique
  `idempotencyKey`, then creates the BigCommerce order and returns
  `{ bcOrderId, confirmationToken, receipt }`. A repeated call with the same key returns
  the stored response.
- `POST /webhooks/shopify/orders` — verifies the `X-Shopify-Hmac-Sha256` header against
  the raw body, links the Shopify order back to our `sourceIdentifier`, and marks the
  BigCommerce order paid.
- `GET /bigcommerce/orders/:id` — custom confirmation endpoint used by the checkout's
  order-confirmation page (see Step 6), since BigCommerce-Admin-created orders aren't
  visible to the native Storefront order-confirmation lookup. Requires the
  `X-Shop-Pay-Confirmation-Token` header (valid for 15 minutes) and deletes the
  BigCommerce cart once the order is retrieved.
- `GET /health` — liveness check.

### Creating the BigCommerce order

`createBigCommerceOrder()`:
1. Resolves each Shop Pay line item's `sku` to a BigCommerce `product_id` via
   `v3/catalog/products?sku=`.
2. Maps the Shop Pay billing/shipping address to BigCommerce's address shape
   (`mapBigCommerceAddress`), using `country_iso2`.
3. Derives the shipping amount from `paymentRequest.totalShippingPrice.finalTotal` (or
   the first `shippingLines` entry) and sends it as `shipping_cost_ex_tax` /
   `shipping_cost_inc_tax` — **BigCommerce does not compute shipping automatically for
   API-created orders**, it must be passed explicitly.
4. `POST`s to `v2/orders` with `status_id` set from `BIGCOMMERCE_PAID_STATUS_ID`.
5. Stores `record.bcOrderId` and calls `reconcileBigCommerceOrder()`.

## Step 3 — Frontend button (`checkout-js/packages/shop-pay-integration`)

- `shopPayConfig.ts` — reads `window.shopPayBackendUrl` / `shopPayClientId` /
  `shopPayShopId`, falling back to POC defaults.
- `shopPaySdk.ts` — loads the Shop Pay SDK script
  (`https://cdn.shopify.com/shopifycloud/shop-js/shop-pay-payment-request.js`),
  `configure()`s it with `shopId`/`clientId`, and `buildShopPayPaymentRequest(cart,
  consignments)` builds the initial `ShopPayPaymentRequestInput` (line items, discount
  codes, available `deliveryMethods`, initial `shippingLines`/`totalShippingPrice` from
  the currently selected BigCommerce shipping option).
- `ShopPayButton.tsx` — creates the SDK session and wires SDK events:
  - `sessionrequested` → calls backend `/shop-pay/session`, completes with
    `token`/`checkoutUrl`/`sourceIdentifier` + an updated payment request.
  - `shippingaddresschanged` → calls `onShippingAddressChanged` (updates the BigCommerce
    consignment address, reloads shipping options, and re-selects a shipping option),
    completes with a rebuilt payment request. Updating the address clears BigCommerce's
    selected option, so the handler re-selects Shop Pay's current delivery method, then
    the previous option, then the recommended/first one. Without this the rebuilt request
    has no shipping line, its total no longer matches the delivery method shown in Shop
    Pay, and Shopify declines the payment in the popup.
  - **`deliverymethodchanged`** → when the buyer picks a shipping option **inside** the
    Shop Pay popup, this event fires with `ev.deliveryMethod`. The handler rebuilds
    `shippingLines` / `totalShippingPrice` / `total` from that selection and calls
    `completeDeliveryMethodChange`. Without this listener, the popup's shipping
    selection never reaches the submitted payment request and BigCommerce orders are
    created with a $0 shipping fee — this was a real bug encountered and fixed during
    this integration.
  - `paymentconfirmationrequested` → posts the SDK's current `session.paymentRequest`
    (which reflects all prior `complete*` updates) plus billing address and an
    idempotency key to `/shop-pay/submit`; stores the returned `bcOrderId`.
  - `paymentcomplete` → waits for the submit result, closes the popup and calls
    `onPaymentComplete(bcOrderId, confirmationToken)`.
  - `windowclosed` → resets the loading state.
- `ShopPayCheckoutControl.tsx` — the component actually rendered in checkout. Reads
  `cart`/`consignments`/`billingAddress` from `useCheckout` (always with a selector, per
  repo convention), decides placement (see Step 4), and implements
  `onShippingAddressChanged` and `onDiscountCodesChanged` with `checkoutService`.

## Step 4 — Wiring into checkout-js core

The control is mounted in two places, and exactly one of them renders (`placement`
prop):

- `packages/core/src/app/checkout/components/CheckoutHeader.tsx` renders
  `placement="top"` ("Checkout with Shop Pay", above the checkout steps).
- `packages/core/src/app/payment/PaymentForm.tsx` renders `placement="payment"` with
  `bcOrderId={checkout.orderId}`, in the payment methods.

The top button is shown only when a billing address and a shipping method were already
known when checkout loaded, for example a signed-in shopper with saved addresses, or a
digital-only cart. A shopper who enters shipping and billing during checkout sees Shop
Pay only in the payment methods. Readiness is recorded the first time a control renders
for a cart (`initialReadinessByCartId`), so the button doesn't jump to the top once the
addresses are complete. Reloading the page after entering addresses shows the top
button, because BigCommerce kept them.

- `packages/core/src/app/payment/Payment.tsx` threads `checkout.orderId` down to
  `PaymentForm`.

## Step 5 — Order reconciliation (webhook)

Shopify order creation is asynchronous, so the client-side `paymentcomplete` event
alone isn't reliable. `POST /webhooks/shopify/orders`:
1. Verifies the HMAC signature using the raw request body (the route is registered
   with `express.raw()` **before** `express.json()` for this reason).
2. Matches `order.source_identifier` (or a `sourceIdentifier` note attribute) back to
   the in-memory `orderMap` record.
3. Calls `reconcileBigCommerceOrder()` to update the BigCommerce order status once
   Shopify confirms payment.

### Where orders actually live

Each successful checkout creates **two** linked orders, not a duplicate of the same
one:

- **Shopify** — created by the `shopPayPaymentRequestSessionSubmit` mutation. This is
  the payment-processing record. View it under **Shopify Admin → Orders**
  (`https://<SHOP_DOMAIN>/admin/orders`), *not* the Shop sales channel/Shop Pay settings
  page — there's no separate "Shop Pay orders" list, Shop Pay is just a payment method
  on a normal Shopify order. Verified via the Admin GraphQL `orders` query that
  `displayFinancialStatus` is `PAID` and totals match the corresponding BigCommerce
  order.
- **BigCommerce** — created by `createBigCommerceOrder()` immediately after the Shopify
  submit succeeds. This is the merchant's order of record and fulfillment source.

If a Shopify order isn't visible, check that you're logged into the exact store used
for Shop Pay Wallet signup (see Step 1) — a regular/second Shopify store won't show
these orders.

## Step 6 — Custom order confirmation

BigCommerce's native order-confirmation page can't look up orders created via the v2
Admin API through the Storefront API, so a custom confirmation was built instead:

- `navigateToShopPayOrderConfirmation` in `packages/utility/src/navigateToOrderConfirmation.ts`
  changes the URL to
  `/checkout/order-confirmation?orderId=<id>&shopPay=1&confirmationToken=<token>` with
  `history.replaceState` plus a `popstate` event, an in-app navigation. A full page
  request to the native route can 302 to the cart for externally created orders.
- `packages/core/src/app/checkout/CheckoutPage.tsx` listens for that `popstate`, detects
  `shopPay=1`, and renders `ShopPayOrderConfirmation` in place of checkout
  (`OrderConfirmationApp.tsx` handles the same params on a direct load).
- `packages/core/src/app/order/ShopPayOrderConfirmation.tsx` fetches
  `${getShopPayBackendUrl()}/bigcommerce/orders/:id` from the backend and renders
  order id/status/products/total, sending the confirmation token header. It reuses `getShopPayBackendUrl()` from
  `shop-pay-integration` rather than hardcoding a URL, so there is a single source of
  truth for the backend URL.

## Deployment

Both apps run on Vercel (team `shop-pay`):

| App | URL | How it deploys |
| --- | --- | --- |
| checkout-js | `https://checkout-js-weld.vercel.app/auto-loader.js` | A push to `master` auto-deploys to production. `vercel.json` builds with `NX_SKIP_NX_CACHE=true npm run build` and serves `dist`. |
| shop-pay-backend | `https://shop-pay-backend.vercel.app` | `vercel --prod` from the backend folder (a folder upload, not git). `.vercelignore` keeps `.env` out. |

- The BigCommerce store (`shoppaystore`, store hash `ocqei08gqj`) loads the checkout
  from the Vercel `auto-loader.js`, configured in the BigCommerce control panel.
- `shopPayConfig.ts` defaults the backend URL to the Vercel backend;
  `window.shopPayBackendUrl` overrides it.
- Backend env vars are Sensitive in Vercel and can't be read back. To check CORS, send
  `OPTIONS /shop-pay/session` with the storefront `Origin`. For a new storefront domain,
  add it to `ALLOWED_ORIGIN` and run `vercel redeploy`.
- To confirm a checkout deploy contains a change, fetch `auto-loader.js`, then grep the
  `checkout-*.js` chunk it lists for an identifier from the change. Shoppers need a hard
  refresh (Ctrl+Shift+R) to pick up a new bundle.
- Local checks before pushing:
  ```powershell
  npx jest packages/shop-pay-integration/src packages/utility/src/navigateToOrderConfirmation.test.ts --runInBand
  npx nx run core:build --skip-nx-cache
  ```
- If a build fails with unrelated TypeScript errors, clear the webpack/ts-loader cache:
  `Remove-Item node_modules\.cache -Recurse -Force`.

## Diagnosing a failed Shop Pay payment

1. **Backend logs**: `vercel logs shop-pay-backend.vercel.app --since 30m --expand`. A
   `POST /shop-pay/session` with no following `POST /shop-pay/submit` means Shopify
   rejected the payment inside the popup, before asking our backend to submit.
2. **Shopify orders**: the Admin GraphQL `orders(first: 5, reverse: true)` query shows
   `sourceIdentifier`, `displayFinancialStatus`, and totals; match the `bc-{cartId}-…`
   identifier to the attempt.
3. **BigCommerce orders**: `v2/orders?sort=id:desc&limit=5` shows whether submit created
   the order, with its shipping and totals.
4. **The popup's own console** (right-click inside the popup → Inspect) is the only place
   Shopify's rejection reason appears; the checkout page console shows only SDK events.

## Demo video

`checkout-js/scripts/record-shop-pay-demo.mjs` records a narrated end-to-end demo as
`packages/test-framework/videos/shop-pay-demo/shop-pay-demo.mp4` (gitignored):

1. Generates one narration clip per step with Windows text-to-speech (`System.Speech`).
2. Runs a guest checkout with Playwright: add a product to the cart, enter email,
   shipping address and method, show Shop Pay in the payment methods, and open the popup.
   Each step's caption is held for as long as its narration lasts.
3. Waits (up to 5 minutes) while the presenter signs in to Shop Pay and presses Pay now,
   then records the in-app order confirmation.
4. Uses ffmpeg to switch to the popup recording while it's open and mix the narration
   clips in at each step's recorded time (`timeline.json`).

```powershell
$env:FFMPEG_PATH = '<path>\ffmpeg.exe'   # e.g. from npm i ffmpeg-static
node scripts/record-shop-pay-demo.mjs
```

Optional overrides: `SHOP_PAY_DEMO_STORE_URL`, `SHOP_PAY_DEMO_PRODUCT_ID`,
`SHOP_PAY_DEMO_EMAIL`, `SHOP_PAY_DEMO_VOICE`, `SHOP_PAY_DEMO_POPUP_TIMEOUT_MS`.

## Known limitations / follow-ups

- Sessions are stored in Upstash Redis (`sessionStore.js`), shared by every Vercel instance, with a 7-day TTL. Without Redis credentials the backend falls back to a JSON file, which suits only one local process.
- Card selection inside the Shop Pay popup is controlled by Shopify. The checkout can't
  preselect a saved card; see the last entry under Challenges.
- There's no real BigCommerce Shop Pay payment method/gateway — orders are created
  directly via the Admin v2 API rather than through `checkoutService.submitOrder()`.
- Product lookup during order creation is by SKU; ensure SKUs are unique and populated.

## Challenges encountered and how they were resolved

- **Deploying the POC.** The Shop Pay SDK and the BigCommerce checkout origin both
  require public HTTPS, so both apps were moved to Vercel. The backend's filesystem is
  read-only there, which caused a 500 on `/shop-pay/session` until the session store
  moved to `/tmp`, and every storefront origin had to be added to `ALLOWED_ORIGIN`.
  Clean Vercel builds also exposed a loader that embedded an empty manifest
  ("'checkout' property is not available in window") and an nx cache replay that left
  `dist` empty; fixed in the loader build and with `NX_SKIP_NX_CACHE=true`.
- **Stale backend URL duplicated in two places.** `shopPayConfig.ts` held the default
  backend URL, but `ShopPayOrderConfirmation.tsx` had its own separate hardcoded
  fallback URL. Updating only one of them left the confirmation page calling an old
  backend URL and failing CORS/404 even after the button itself worked. Fixed by making the
  confirmation page reuse the single `getShopPayBackendUrl()` helper instead of
  hardcoding a URL.
- **Dead code left in `/shop-pay/session`.** A leftover, copy-pasted block referenced an
  undefined `order` variable inside the session-create route, throwing a
  `ReferenceError` on every call. `node --check` (syntax-only) didn't catch it because
  the bug was a runtime reference error, not a syntax error. Removed the block.
- **Shipping fee showing as $0 on the BigCommerce order.** Two separate bugs combined:
  1. `createBigCommerceOrder()` never sent `shipping_cost_ex_tax` /
     `shipping_cost_inc_tax` to BigCommerce's v2 Orders API — BigCommerce does not
     compute shipping automatically for orders created via the Admin API.
  2. The Shop Pay SDK's `deliverymethodchanged` event (fired when the buyer picks a
     shipping option **inside** the popup) wasn't handled in `ShopPayButton.tsx`, so the
     selected shipping cost never made it into `session.paymentRequest` — which is what
     gets submitted to the backend. Confirmed via temporary request logging on
     `/shop-pay/session` and `/shop-pay/submit` before and after the fix. Fixed by adding
     a `deliverymethodchanged` listener that rebuilds `shippingLines` /
     `totalShippingPrice` / `total` and calls `completeDeliveryMethodChange`.
- **Native order confirmation incompatible with Admin-created orders.** BigCommerce's
  built-in order-confirmation page looks up orders through the Storefront API, which
  can't see orders created via the v2 Admin API. Solved by adding a custom
  confirmation route (`?shopPay=1`) and a dedicated backend endpoint
  (`GET /bigcommerce/orders/:id`) that queries the order list + product subresource
  directly (a direct `v2/orders/:id` lookup returned 404 for these orders).
- **Windows-specific build friction.** The `core:dev` Nx target used
  `MEASURE_SPEED=false webpack ...`, which isn't valid PowerShell/cmd syntax. Also,
  concurrent watchers (webpack `--watch` plus manual generate) raced on deleting/
  regenerating `packages/core/src/app/generated/**`, intermittently breaking the
  polyfill import. Fixed by adjusting the `core:dev` command for Windows and preferring
  a manual `nx run core:generate` + one-shot `webpack --mode development` build loop
  over concurrent watchers when debugging.
- **Stale `node_modules/.cache` causing a false build failure.** An unrelated
  `TS2305: Module "card-validator" has no exported member 'creditCardType'` error
  appeared after a `generate` step, even though the relevant files were untouched.
  Clearing `node_modules/.cache` resolved it — a stale ts-loader cache, not a real
  regression.
- **BigCommerce order/idempotency confusion.** Repeated Shop Pay submit retries need a
  stable `idempotencyKey` per checkout attempt (`crypto.randomUUID()` generated once per
  session and reused on retry) to avoid duplicate Shopify charges/orders during testing.
- **Payment declined after a shipping address change.** When Shop Pay sent the shopper's
  address, updating the BigCommerce consignment cleared its selected shipping option. The
  rebuilt payment request had no shipping line and a lower total than the delivery method
  still shown in Shop Pay, and the popup showed "There was an issue with your selected
  payment method". The backend logs showed sessions with no submit. Fixed by re-selecting
  a shipping option after the address update.
- **Shop Pay button jumping to the top.** With one button at the top and one in the
  payment step, a guest who filled in addresses during checkout saw the button move to
  the top once they were complete. Placement is now decided from the checkout state when
  checkout loads.
- **Saved card not selected in the popup.** In some attempts the saved test card was
  listed but not selected, and Pay now showed "There was an issue with your selected
  payment method" until the shopper clicked the card. Card selection is owned by Shopify
  and the Shop Pay Payment Request API has no way to preselect it; if it persists,
  re-add the card in test mode or raise it with Shopify.
- **"Unknown sourceIdentifier" on some payments.** Sessions were saved to each Vercel
  instance's own `/tmp` file, so when Pay now reached a different instance than the
  one that created the session, the session wasn't found. Fixed by moving sessions to
  Upstash Redis, connected through the Vercel Marketplace.

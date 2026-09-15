# Shop Pay Wallet + BigCommerce Custom Checkout — Integration Guide

This documents how Shop Pay Wallet was wired into the BigCommerce custom checkout
(`checkout-js`) via a small Node backend (`shop-pay-backend`), end to end.

## Architecture overview

```
Browser (BigCommerce custom checkout, checkout-js)
        │  1. renders Shop Pay button, loads Shop Pay JS SDK
        ▼
Shop Pay popup (Shopify-hosted)
        │  2. fires session/shipping/payment events
        ▼
shop-pay-backend (Node/Express, port 8787)
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
3. Add the checkout origin (e.g. `https://integrateshoppay.mybigcommerce.com`) to the
   Shop Pay domain allow list.
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
| `PORT` | Backend port (`8787`) |

Routes:

- `POST /shop-pay/session` — builds a `ShopPayPaymentRequestInput` from the BigCommerce
  cart and calls `shopPayPaymentRequestSessionCreate` on the Storefront API. Stores the
  session (`token`, `paymentRequest`, `sourceIdentifier`) in memory (`orderMap`), returns
  `{ token, checkoutUrl, sourceIdentifier }` to the browser.
- `POST /shop-pay/submit` — called when the buyer clicks **Pay now**. Merges the final
  payment request (shipping lines, totals, payment method) sent by the frontend into the
  stored request, calls `shopPayPaymentRequestSessionSubmit` with a unique
  `idempotencyKey`, then creates the BigCommerce order.
- `POST /webhooks/shopify/orders` — verifies the `X-Shopify-Hmac-Sha256` header against
  the raw body, links the Shopify order back to our `sourceIdentifier`, and marks the
  BigCommerce order paid.
- `GET /bigcommerce/orders/:id` — custom confirmation endpoint used by the checkout's
  order-confirmation page (see Step 6), since BigCommerce-Admin-created orders aren't
  visible to the native Storefront order-confirmation lookup.
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
    consignment address + reloads shipping options), completes with a rebuilt payment
    request.
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
  - `paymentcomplete` → closes the popup and calls `onPaymentComplete(bcOrderId)`.
  - `windowclosed` → resets the loading state.
- `ShopPayCheckoutControl.tsx` — the component actually rendered in checkout. Reads
  `cart`/`consignments` from `useCheckout` (always with a selector, per repo
  convention), and implements `onShippingAddressChanged` by calling
  `checkoutService.updateConsignment()` + `loadShippingOptions()`.

## Step 4 — Wiring into checkout-js core

- `packages/core/src/app/payment/PaymentForm.tsx` renders
  `<ShopPayCheckoutControl backendUrl={...} bcOrderId={checkout.orderId}
  onPaymentComplete={props.onSubmit} />` only when a backend URL is configured — the
  Shop Pay control is opt-in and kept out of hosted checkout by design.
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

- `packages/utility/src/navigateToOrderConfirmation.ts` redirects to
  `/checkout/order-confirmation?orderId=<id>&shopPay=1` instead of the native route.
- `packages/core/src/app/order/OrderConfirmationApp.tsx` detects the `shopPay=1` query
  param and renders `ShopPayOrderConfirmation` instead of the native Storefront lookup.
- `packages/core/src/app/order/ShopPayOrderConfirmation.tsx` fetches
  `${getShopPayBackendUrl()}/bigcommerce/orders/:id` from the backend and renders
  order id/status/products/total. It reuses `getShopPayBackendUrl()` from
  `shop-pay-integration` rather than hardcoding a URL, so there is a single source of
  truth for the backend URL.

## Local development notes

- Backend runs on `8787`, the checkout dev bundle loader on `8080`; both need public
  HTTPS via `ngrok` for the BigCommerce-hosted checkout to reach them
  (`ngrok http 8787`, `ngrok http 8080`).
- After changing anything under `packages/shop-pay-integration` or
  `packages/core/src/app/order`, rebuild with:
  ```powershell
  npx nx run core:generate
  npx webpack --mode development
  ```
- If a build fails with unrelated TypeScript errors after a clean checkout, clear the
  webpack/ts-loader cache: `Remove-Item node_modules\.cache -Recurse -Force`.
- Whichever ngrok URL backs `8787` must be kept in sync with the browser-side default in
  `shopPayConfig.ts` (or set via `window.shopPayBackendUrl` in BigCommerce Script
  Manager) — expired ngrok tunnels are the most common source of CORS/404 errors during
  local testing.

## Known limitations / follow-ups

- `orderMap` is in-memory only; restart the backend loses session/reconciliation state.
  Replace with Redis/Postgres before going beyond POC.
- There's no real BigCommerce Shop Pay payment method/gateway — orders are created
  directly via the Admin v2 API rather than through `checkoutService.submitOrder()`.
- Product lookup during order creation is by SKU; ensure SKUs are unique and populated.

## Challenges encountered and how they were resolved

- **Local HTTPS + CORS for the Shop Pay popup.** The Shop Pay SDK and the BigCommerce
  checkout origin both require HTTPS, so the local backend (`8787`) and the checkout
  loader (`8080`) had to be tunneled with `ngrok`. Free ngrok URLs expire/rotate on
  every restart, which repeatedly broke CORS (`No 'Access-Control-Allow-Origin' header`)
  until the *current* tunnel URL was re-verified and re-applied everywhere it was
  referenced.
- **Stale backend URL duplicated in two places.** `shopPayConfig.ts` held the default
  backend URL, but `ShopPayOrderConfirmation.tsx` had its own separate hardcoded
  fallback URL. Updating only one of them left the confirmation page calling an expired
  tunnel and failing CORS/404 even after the button itself worked. Fixed by making the
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

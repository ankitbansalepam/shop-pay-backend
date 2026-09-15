# Shop Pay POC Analysis

## Current status
The backend skeleton exists, but the BigCommerce-to-Shopify Shop Pay flow is not end to end.

## Confirmed architecture

- `checkout-js/` is the BigCommerce checkout SDK/library. It contains wallet-button patterns but no Shop Pay integration, SDK loader, method registration, or event handlers.
- `Cornorstone/Cornerstone-6.21.0/` is a Stencil theme. Its checkout page renders BigCommerce hosted `checkout.checkout_content`; it does not own the checkout payment UI.
- `shop-pay-backend/` owns Shopify GraphQL calls, Shop Pay session state, and webhook handling.

## Blocking gaps

1. **No frontend client:** create-session, payment-confirmation, payment-complete, and address/delivery update events are not implemented in checkout-js or a custom checkout app.
2. **Hosted checkout boundary:** adding a button to Cornerstone alone will not integrate with hosted Optimized One-Page Checkout. A custom checkout UI using checkout-js, or an officially supported BigCommerce payment integration surface, is required.
3. **No BigCommerce reconciliation:** the webhook has a TODO to mark the BigCommerce order paid and persist the Shopify order reference.
4. **Volatile state:** `orderMap` is an in-memory Map, so a restart loses session correlation. This is acceptable only for a deliberate demo and must be replaced for a reliable POC.
5. **Input trust:** the backend accepts client totals and line-item prices. A real integration must load or validate the cart server-side before creating a payment request.
6. **Submit authorization:** submit currently accepts a request token when supplied. The stored session token should be the source of truth, with a signed or authenticated client correlation value.
7. **Contract tests:** there are no tests for request mapping, GraphQL user errors, idempotent submit, HMAC verification, or webhook replay.

## Recommended completion order

### Phase 1: backend demo safety
- Add strict cart validation and decimal-safe amount handling.
- Always submit with the server-stored session token.
- Add request correlation/authentication appropriate for the demo.
- Add focused tests for session mapping, submit, HMAC, and duplicate webhook delivery.
- Keep the Map only if the POC explicitly documents restart loss.

### Phase 2: frontend proof of flow
- Build a small custom checkout page/app using checkout-js.
- Add a Shop Pay adapter that calls `POST /shop-pay/session`.
- Render the returned `checkoutUrl` or use the Shop Pay web component/SDK required by the approved Shopify integration contract.
- Handle payment confirmation by calling `POST /shop-pay/submit` once with an idempotency key.
- Redirect on payment completion and show recoverable errors.
- Add CORS, origin, and environment configuration for the deployed frontend.

### Phase 3: BigCommerce reconciliation
- Create or identify the BigCommerce order before payment where required by the checkout contract.
- Use BigCommerce Orders API credentials server-side.
- On Shopify order webhook, mark the BigCommerce order paid and persist Shopify order ID/name.
- Make reconciliation idempotent and retryable.

## POC acceptance criteria

- A real BigCommerce cart can start a Shop Pay session from the custom checkout UI.
- A user can complete payment in Shop Pay.
- The confirmation callback submits exactly once and returns a receipt.
- A Shopify order webhook links to the originating BigCommerce order after backend restart.
- Invalid totals, unknown sessions, invalid HMAC, and repeated webhooks are handled safely.
- No Shopify, BigCommerce, DIAL, or webhook secrets reach browser code or committed files.

## Required decisions before frontend implementation

- Whether the target is a custom checkout app or hosted Optimized One-Page Checkout.
- Approved Shop Pay SDK/web-component version and browser event contract.
- BigCommerce store hash, checkout API/auth approach, and order lifecycle expected by the merchant.
- Persistence choice for the POC: SQLite, Redis, or documented in-memory demo.
- Public HTTPS URLs for frontend, backend, and Shopify webhook registration.

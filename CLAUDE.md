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

Do not change Shopify API versions, GraphQL fields, or payment-flow semantics without checking the relevant Shopify contract.

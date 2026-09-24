// ---------------------------------------------------------------------------
// Shop Pay Wallet POC middleware
//
// Flow (per https://shopify.dev/docs/api/commerce-components/pay):
//   BigCommerce custom checkout  ->  this backend  ->  Shopify Storefront API
//
//   1. POST /shop-pay/session   -> shopPayPaymentRequestSessionCreate
//   2. POST /shop-pay/submit    -> shopPayPaymentRequestSessionSubmit
//   3. POST /webhooks/shopify/orders -> reconciliation (mark paid + store ref)
//
// Node 20+ (global fetch, crypto). Secrets come from .env — never sent to the
// browser. Only { token, checkoutUrl, sourceIdentifier } is returned to the FE.
// ---------------------------------------------------------------------------

import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import cors from 'cors';

import { createSessionStore, sessionStoreKind } from './sessionStore.js';
import {
    describeScheduledDelivery,
    getAvailableDeliveryDates,
    isEligibleAddress,
    isScheduledProduct,
    SCHEDULED_SERVICES,
    validateScheduledDelivery,
} from './delivery.js';
import { validateCart, validateFinalPaymentRequest, validateTotalMatchesCheckout } from './validation.js';

const {
    SHOP_DOMAIN,
    SHOP_ID,
    STOREFRONT_API_TOKEN,
    SHOPIFY_WEBHOOK_SECRET,
    ADMIN_API_TOKEN,
    SHOPIFY_API_VERSION = '2025-07',
    BIGCOMMERCE_STORE_HASH = '',
    BIGCOMMERCE_ACCESS_TOKEN = '',
    BIGCOMMERCE_API_URL = 'https://api.bigcommerce.com',
    BIGCOMMERCE_PAID_STATUS_ID = '11',
    BIGCOMMERCE_CREATE_ORDER = 'false',
    PORT = 8787,
    ALLOWED_ORIGIN = '',
    // Vercel's filesystem is read-only except /tmp.
    SESSION_STORE_PATH = process.env.VERCEL ? '/tmp/shop-pay-sessions.json' : 'data/shop-pay-sessions.json',
} = process.env;

if (!SHOP_DOMAIN) console.warn('[warn] SHOP_DOMAIN is empty — set it in .env (e.g. your-store.myshopify.com)');
if (!STOREFRONT_API_TOKEN) console.warn('[warn] STOREFRONT_API_TOKEN is empty — session mutations will fail.');
if (!SHOPIFY_WEBHOOK_SECRET) console.warn('[warn] SHOPIFY_WEBHOOK_SECRET is empty — /webhooks/shopify/orders will reject every request with 401.');

const STOREFRONT_ENDPOINT = `https://${SHOP_DOMAIN}/api/${SHOPIFY_API_VERSION}/graphql.json`;

const CONFIRMATION_TOKEN_TTL_MS = 15 * 60 * 1000;
const sessionStore = createSessionStore(path.resolve(process.cwd(), SESSION_STORE_PATH));

const app = express();

// Webhook route needs the RAW body for HMAC — register it BEFORE express.json().
app.use('/webhooks/shopify', express.raw({ type: '*/*' }));
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: ALLOWED_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean) }));

// ---------------------------------------------------------------------------
// GraphQL helper
// ---------------------------------------------------------------------------
async function storefront(query, variables) {
    const res = await fetch(STOREFRONT_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Storefront-Access-Token': STOREFRONT_API_TOKEN,
        },
        body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) {
        throw new Error(`Storefront API errors: ${JSON.stringify(json.errors)}`);
    }
    return json.data;
}

// ---------------------------------------------------------------------------
// Build a ShopPayPaymentRequestInput from a BigCommerce-style cart payload.
//
// NOTE: the nested ShopPayPaymentRequestLineItemInput sub-fields below are the
// commonly-documented ones; verify against the live schema for your API version
// before going past POC. Amounts are strings ("Decimal") per MoneyInput.
// ---------------------------------------------------------------------------
function buildPaymentRequest(cart) {
    const currency = cart.currencyCode || 'USD';
    const money = (amount) => ({ amount: String(amount), currencyCode: currency });

    const lineItems = (cart.lineItems || []).map((li) => ({
        label: li.name,
        quantity: li.quantity,
        sku: li.sku || undefined,
        requiresShipping: li.requiresShipping !== false,
        originalItemPrice: money(li.listPrice ?? li.salePrice),
        finalItemPrice: money(li.salePrice ?? li.listPrice),
        originalLinePrice: money((li.listPrice ?? li.salePrice) * li.quantity),
        finalLinePrice: money((li.salePrice ?? li.listPrice) * li.quantity),
        ...(li.imageUrl ? { image: { url: li.imageUrl, alt: li.name } } : {}),
    }));

    const shippingLines = (cart.shippingLines || []).map((s) => ({
        label: s.label,
        amount: money(s.amount),
    }));

    return {
        locale: cart.locale || 'en',
        presentmentCurrency: currency,
        lineItems,
        shippingLines,
        subtotal: money(cart.subtotal),
        total: money(cart.total),
        ...(cart.totalTax != null ? { totalTax: money(cart.totalTax) } : {}),
        ...(cart.totalShipping != null
            ? { totalShippingPrice: { discountedAmount: money(cart.totalShipping) } }
            : {}),
        ...(cart.discountCodes?.length ? { discountCodes: cart.discountCodes } : {}),
    };
}

function normalizeMoney(money) {
    return {
        ...money,
        amount: String(money.amount),
    };
}

function normalizeMoneyLines(lines) {
    return lines.map((line) => ({
        ...line,
        amount: normalizeMoney(line.amount),
    }));
}

function normalizeShippingTotal(total) {
    return {
        ...total,
        ...(total.originalTotal ? { originalTotal: normalizeMoney(total.originalTotal) } : {}),
        finalTotal: normalizeMoney(total.finalTotal),
    };
}

// ---------------------------------------------------------------------------
// 1) Create session  (pre-payment)
// ---------------------------------------------------------------------------
const CREATE = /* GraphQL */ `
  mutation shopPayCreate($paymentRequest: ShopPayPaymentRequestInput!, $sourceIdentifier: String!) {
    shopPayPaymentRequestSessionCreate(paymentRequest: $paymentRequest, sourceIdentifier: $sourceIdentifier) {
      shopPayPaymentRequestSession {
        token
        checkoutUrl
        sourceIdentifier
      }
      userErrors { code field message }
    }
  }
`;

app.post('/shop-pay/session', async (req, res) => {
    try {
        const cart = req.body?.cart;
        const validationError = validateCart(cart);
        if (validationError) return res.status(400).json({ error: validationError });

        // sourceIdentifier MUST be unique per order (used for reconciliation).
        const sourceIdentifier = req.body.sourceIdentifier || `bc-${cart.cartId || crypto.randomUUID()}`;
        if (typeof sourceIdentifier !== 'string' || sourceIdentifier.length > 200) {
            return res.status(400).json({ error: 'Invalid sourceIdentifier' });
        }

        const existingRecord = await sessionStore.get(sourceIdentifier);
        if (existingRecord && existingRecord.status !== 'session_created') {
            return res.status(409).json({ error: 'This Shop Pay session has already been submitted' });
        }
        // A repeated request for the same attempt gets the same Shopify session; a second
        // session would leave the popup paying one while /submit submits the other.
        if (existingRecord?.token && existingRecord.checkoutUrl) {
            return res.json({
                token: existingRecord.token,
                checkoutUrl: existingRecord.checkoutUrl,
                sourceIdentifier,
            });
        }

        const { scheduledDelivery } = req.body;
        if (
            scheduledDelivery &&
            (typeof scheduledDelivery !== 'object' ||
                typeof scheduledDelivery.date !== 'string' ||
                String(scheduledDelivery.instructions || '').length > 500)
        ) {
            return res.status(400).json({ error: 'Invalid scheduled delivery' });
        }

        const paymentRequest = buildPaymentRequest(cart);

        const data = await storefront(CREATE, { paymentRequest, sourceIdentifier });
        const payload = data.shopPayPaymentRequestSessionCreate;

        if (payload.userErrors?.length) {
            return res.status(422).json({ userErrors: payload.userErrors });
        }

        const session = payload.shopPayPaymentRequestSession;
        // Remember what we sent, so /submit can resend the same paymentRequest.
        await sessionStore.save({
            bcCartId: cart.cartId,
            bcOrderId: req.body.bcOrderId || null,
            confirmationToken: crypto.randomBytes(32).toString('hex'),
            sourceIdentifier,
            token: session.token,
            checkoutUrl: session.checkoutUrl,
            paymentRequest,
            scheduledDelivery: scheduledDelivery
                ? { date: scheduledDelivery.date, instructions: String(scheduledDelivery.instructions || '').trim() }
                : null,
            status: 'session_created',
            createdAt: Date.now(),
        });

        return res.json({
            token: session.token,
            checkoutUrl: session.checkoutUrl,
            sourceIdentifier: session.sourceIdentifier,
        });
    } catch (err) {
        console.error('[session] error:', err);
        return res.status(500).json({ error: String(err.message || err) });
    }
});

// ---------------------------------------------------------------------------
// 2) Submit session  (post-payment — fired on paymentconfirmationrequested)
// ---------------------------------------------------------------------------
const SUBMIT = /* GraphQL */ `
  mutation shopPaySubmit($idempotencyKey: String!, $token: String!, $paymentRequest: ShopPayPaymentRequestInput!, $orderName: String) {
    shopPayPaymentRequestSessionSubmit(idempotencyKey: $idempotencyKey, token: $token, paymentRequest: $paymentRequest, orderName: $orderName) {
      paymentRequestReceipt {
        token
                processingStatusType
      }
      userErrors { code field message }
    }
  }
`;

app.post('/shop-pay/submit', async (req, res) => {
    try {
        const {
            sourceIdentifier,
            idempotencyKey,
            paymentMethod,
            paymentRequest: finalPaymentRequest,
            billingAddress,
        } = req.body || {};
        const record = await sessionStore.get(sourceIdentifier);
        if (!record) return res.status(404).json({ error: 'Unknown sourceIdentifier — create a session first' });
        if (typeof sourceIdentifier !== 'string' || sourceIdentifier.length > 200) {
            return res.status(400).json({ error: 'Invalid sourceIdentifier' });
        }
        if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200) {
            return res.status(400).json({ error: 'A valid idempotencyKey is required' });
        }
        if (record.idempotencyKey && record.idempotencyKey !== idempotencyKey) {
            return res.status(409).json({ error: 'This Shop Pay session has already been submitted with another idempotency key' });
        }
        if (record.idempotencyKey === idempotencyKey && record.submitResponse) {
            return res.json(record.submitResponse);
        }
        record.idempotencyKey = idempotencyKey;
        await sessionStore.save(record);

        // Reuse the exact paymentRequest we created the session with (server-side
        // source of truth). For POC we trust our stored copy over client input.
        const paymentRequest = {
            ...record.paymentRequest,
            ...(paymentMethod ? { paymentMethod } : {}),
            ...(finalPaymentRequest?.shippingLines
                ? { shippingLines: normalizeMoneyLines(finalPaymentRequest.shippingLines) }
                : {}),
            ...(finalPaymentRequest?.totalShippingPrice
                ? { totalShippingPrice: normalizeShippingTotal(finalPaymentRequest.totalShippingPrice) }
                : {}),
            ...(finalPaymentRequest?.discountCodes
                ? { discountCodes: finalPaymentRequest.discountCodes }
                : {}),
            ...(finalPaymentRequest?.discounts
                ? { discounts: normalizeMoneyLines(finalPaymentRequest.discounts) }
                : {}),
            ...(finalPaymentRequest?.total
                ? { total: normalizeMoney(finalPaymentRequest.total) }
                : {}),
        };
        const paymentRequestError = validateFinalPaymentRequest(paymentRequest, record.paymentRequest);
        if (paymentRequestError) return res.status(422).json({ error: paymentRequestError });
        if (BIGCOMMERCE_STORE_HASH && BIGCOMMERCE_ACCESS_TOKEN) {
            const checkout = await getBigCommerceCheckout(record.bcCartId);
            const deliveryError = await validateCheckoutDelivery(record, checkout);
            if (deliveryError) {
                console.warn(`[submit] ${sourceIdentifier}: ${deliveryError}`);
                return res.status(422).json({ error: deliveryError });
            }
            const totalError = validateTotalMatchesCheckout(paymentRequest, checkout);
            if (totalError) {
                console.warn(
                    `[submit] ${totalError}: submitted ${paymentRequest.total?.amount}, checkout ${checkout?.grand_total}`,
                );
                return res.status(422).json({ error: totalError });
            }
        }
        const data = await storefront(SUBMIT, {
            idempotencyKey,
            token: record.token,
            paymentRequest,
            orderName: null,
        });
        const payload = data.shopPayPaymentRequestSessionSubmit;

        if (payload.userErrors?.length) {
            console.error('[submit] Shopify userErrors:', JSON.stringify(payload.userErrors));
            return res.status(422).json({ userErrors: payload.userErrors });
        }

        // Submitting only starts payment processing; the BigCommerce order is created by
        // /shop-pay/complete once Shopify has a paid order for this session.
        record.status = 'submitted';
        record.receipt = payload.paymentRequestReceipt;
        record.finalPaymentRequest = paymentRequest;
        record.billingAddress = billingAddress || null;
        console.log(
            `[submit] ${sourceIdentifier} submitted; processing status ${payload.paymentRequestReceipt?.processingStatusType}`,
        );
        const response = { receipt: payload.paymentRequestReceipt };
        record.submitResponse = response;
        await sessionStore.save(record);
        return res.json(response);
    } catch (err) {
        console.error('[submit] error:', err);
        return res.status(500).json({ error: String(err.message || err) });
    }
});

// ---------------------------------------------------------------------------
// 2b) Complete  (fired on paymentcomplete) — the BigCommerce order is created only
//     once Shopify has a paid order for this session, so a failed payment never
//     leaves a "paid" BigCommerce order behind.
// ---------------------------------------------------------------------------
const RECENT_ORDERS = /* GraphQL */ `
  query shopPayRecentOrders($query: String!) {
    orders(first: 20, reverse: true, sortKey: CREATED_AT, query: $query) {
      nodes { id name sourceIdentifier displayFinancialStatus totalPriceSet { shopMoney { amount } } }
    }
  }
`;
const PAID_FINANCIAL_STATUSES = new Set(['PAID', 'AUTHORIZED']);
const COMPLETE_ATTEMPTS = 4;
const COMPLETE_RETRY_MS = 2000;

async function findShopifyOrder(record) {
    const since = new Date(record.createdAt - 60 * 1000).toISOString();
    const response = await fetch(`https://${SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ADMIN_API_TOKEN },
        body: JSON.stringify({ query: RECENT_ORDERS, variables: { query: `created_at:>='${since}'` } }),
    });
    const json = await response.json();

    if (!response.ok || json.errors) {
        throw new Error(`Shopify Admin API error: ${JSON.stringify(json.errors || response.status)}`);
    }

    return json.data.orders.nodes.find((order) => order.sourceIdentifier === record.sourceIdentifier) || null;
}

app.post('/shop-pay/complete', async (req, res) => {
    let completeLock;

    try {
        const { sourceIdentifier } = req.body || {};
        if (typeof sourceIdentifier !== 'string' || sourceIdentifier.length > 200) {
            return res.status(400).json({ error: 'Invalid sourceIdentifier' });
        }

        let record = await sessionStore.get(sourceIdentifier);
        if (!record) return res.status(404).json({ error: 'Unknown sourceIdentifier — create a session first' });
        if (record.completedAt) {
            return res.json({ bcOrderId: record.bcOrderId, confirmationToken: record.confirmationToken });
        }

        // Only one call may create the BigCommerce order; a concurrent call is told to
        // retry, and then receives the order the first call created.
        if (!(await sessionStore.lock(`complete:${sourceIdentifier}`))) {
            return res.status(202).json({ pending: true });
        }
        completeLock = `complete:${sourceIdentifier}`;
        record = await sessionStore.get(sourceIdentifier);
        if (record.completedAt) {
            return res.json({ bcOrderId: record.bcOrderId, confirmationToken: record.confirmationToken });
        }
        if (record.status !== 'submitted' || !record.finalPaymentRequest) {
            return res.status(409).json({ error: 'This Shop Pay session has not been submitted' });
        }

        let order = null;
        for (let attempt = 0; attempt < COMPLETE_ATTEMPTS && !order; attempt += 1) {
            if (attempt) await new Promise((resolve) => setTimeout(resolve, COMPLETE_RETRY_MS));
            order = await findShopifyOrder(record);
        }

        if (!order || !PAID_FINANCIAL_STATUSES.has(order.displayFinancialStatus)) {
            // Shopify creates the order shortly after the payment; the client asks again.
            return res.status(202).json({ pending: true, financialStatus: order?.displayFinancialStatus || null });
        }

        const paid = Number(order.totalPriceSet?.shopMoney?.amount);
        const expected = Number(record.finalPaymentRequest.total?.amount);
        if (!(Math.abs(paid - expected) <= 0.01 + 1e-9)) {
            console.error(`[complete] ${sourceIdentifier}: Shopify ${order.name} paid ${paid}, expected ${expected}`);
            return res.status(409).json({ error: 'The Shopify payment does not match the order total' });
        }

        record.shopifyOrderId = order.id;
        record.shopifyOrderName = order.name;
        record.financialStatus = order.displayFinancialStatus;

        if (record.bcOrderId) {
            await reconcileBigCommerceOrder(record);
        } else {
            await createBigCommerceOrder(record, record.finalPaymentRequest, record.billingAddress);
        }

        if (!record.bcOrderId) {
            return res.status(500).json({ error: 'The BigCommerce order was not created' });
        }

        record.completedAt = Date.now();
        await sessionStore.save(record);
        console.log(`[complete] ${sourceIdentifier}: Shopify ${order.name} paid -> BigCommerce order ${record.bcOrderId}`);

        return res.json({ bcOrderId: record.bcOrderId, confirmationToken: record.confirmationToken });
    } catch (err) {
        console.error('[complete] error:', err);
        return res.status(500).json({ error: String(err.message || err) });
    } finally {
        if (completeLock) {
            await sessionStore.unlock(completeLock).catch((err) => console.error('[complete] unlock failed:', err));
        }
    }
});

// ---------------------------------------------------------------------------
// 3) Shopify order webhook — reconciliation (raw body verified via HMAC)
// ---------------------------------------------------------------------------
function verifyShopifyHmac(req) {
    if (!SHOPIFY_WEBHOOK_SECRET) return false;
    const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
    const digest = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(req.body).digest('base64');
    try {
        return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(digest));
    } catch {
        return false;
    }
}

async function reconcileBigCommerceOrder(record) {
    if (!record.bcOrderId) {
        console.warn(`[webhook] no BigCommerce order ID for ${record.sourceIdentifier}; skipping order update`);
        return;
    }

    if (!BIGCOMMERCE_STORE_HASH || !BIGCOMMERCE_ACCESS_TOKEN) {
        console.warn('[webhook] BigCommerce credentials are not configured; skipping order update');
        return;
    }

    const response = await fetch(
        `${BIGCOMMERCE_API_URL}/stores/${BIGCOMMERCE_STORE_HASH}/v2/orders/${record.bcOrderId}`,
        {
            method: 'PUT',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'X-Auth-Token': BIGCOMMERCE_ACCESS_TOKEN,
            },
            body: JSON.stringify({ status_id: Number(BIGCOMMERCE_PAID_STATUS_ID) }),
        },
    );

    if (!response.ok) {
        throw new Error(`BigCommerce order update failed with HTTP ${response.status}: ${await response.text()}`);
    }

    record.bigCommerceStatusId = Number(BIGCOMMERCE_PAID_STATUS_ID);
    await sessionStore.save(record);
    console.log(`[webhook] marked BigCommerce order ${record.bcOrderId} paid for Shopify order ${record.shopifyOrderName}`);
}

async function clearBigCommerceCart(record) {
    if (!record.bcCartId || record.cartCleared) {
        return;
    }

    if (!BIGCOMMERCE_STORE_HASH || !BIGCOMMERCE_ACCESS_TOKEN) {
        console.warn('[shop-pay] BigCommerce credentials are not configured; skipping cart clear');
        return;
    }

    try {
        const response = await fetch(
            `${BIGCOMMERCE_API_URL}/stores/${BIGCOMMERCE_STORE_HASH}/v3/carts/${record.bcCartId}`,
            {
                method: 'DELETE',
                headers: {
                    Accept: 'application/json',
                    'X-Auth-Token': BIGCOMMERCE_ACCESS_TOKEN,
                },
            },
        );

        if (response.status === 404) {
            console.log(`[shop-pay] cart ${record.bcCartId} already removed; continuing`);
            record.cartCleared = true;
                await sessionStore.save(record);
            return;
        }

        if (!response.ok && response.status !== 204) {
            const text = await response.text();
            throw new Error(`BigCommerce cart delete failed with HTTP ${response.status}: ${text}`);
        }

        record.cartCleared = true;
        await sessionStore.save(record);
        console.log(`[shop-pay] cleared BigCommerce cart ${record.bcCartId} after order ${record.bcOrderId}`);
    } catch (err) {
        console.error('[shop-pay] failed to clear cart after order completion:', err);
    }
}

function mapBigCommerceAddress(address = {}) {
    return {
        first_name: address.firstName || '',
        last_name: address.lastName || '',
        street_1: address.address1 || '',
        street_2: address.address2 || '',
        city: address.city || '',
        state: address.provinceCode || address.province || '',
        zip: address.postalCode || '',
        country_iso2: address.countryCode || 'US',
        email: address.email || '',
        phone: address.phone || '',
    };
}

const scheduledProductCache = new Map();
const SCHEDULED_PRODUCT_CACHE_MS = 5 * 60 * 1000;

// Product IDs (of those given) whose custom field marks them for scheduled delivery.
async function getScheduledProductIds(productIds) {
    const ids = [...new Set(productIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    const now = Date.now();
    const missing = ids.filter((id) => !(scheduledProductCache.get(id)?.expiresAt > now));

    if (missing.length) {
        const response = await fetch(
            `${BIGCOMMERCE_API_URL}/stores/${BIGCOMMERCE_STORE_HASH}/v3/catalog/products?id:in=${missing.join(',')}&include=custom_fields&limit=250`,
            { headers: { Accept: 'application/json', 'X-Auth-Token': BIGCOMMERCE_ACCESS_TOKEN } },
        );
        if (!response.ok) throw new Error(`BigCommerce product lookup failed with HTTP ${response.status}`);

        const products = (await response.json()).data || [];
        for (const id of missing) {
            const product = products.find((entry) => entry.id === id);
            scheduledProductCache.set(id, { scheduled: isScheduledProduct(product), expiresAt: now + SCHEDULED_PRODUCT_CACHE_MS });
        }
    }

    return ids.filter((id) => scheduledProductCache.get(id)?.scheduled);
}

function checkoutProductIds(checkout) {
    const items = checkout?.cart?.line_items || {};

    return [...(items.physical_items || []), ...(items.digital_items || [])].map((item) => item.product_id);
}

// For carts with scheduled-delivery products, the BigCommerce checkout must have a
// scheduled service selected and the session a valid date for the delivery address.
async function validateCheckoutDelivery(record, checkout) {
    if (!checkout) return null;
    if (!(await getScheduledProductIds(checkoutProductIds(checkout))).length) return null;

    const consignment = checkout.consignments?.[0];
    const service = consignment?.selected_shipping_option?.description;
    if (!SCHEDULED_SERVICES.includes(service)) return 'Choose a scheduled delivery service for this cart';

    return validateScheduledDelivery(record.scheduledDelivery, {
        countryCode: consignment.address?.country_code,
        postalCode: consignment.address?.postal_code,
    });
}

// Tells checkout whether the cart needs scheduled delivery and, for an address, which
// dates are available (mock ATP; see delivery.js).
app.post('/delivery/options', async (req, res) => {
    try {
        const { productIds, address } = req.body || {};
        if (!Array.isArray(productIds) || productIds.length > 100) {
            return res.status(400).json({ error: 'productIds must be an array' });
        }

        const scheduled = (await getScheduledProductIds(productIds)).length > 0;

        return res.json({
            scheduled,
            services: SCHEDULED_SERVICES,
            eligible: scheduled && address ? isEligibleAddress(address) : null,
            dates: scheduled && address ? getAvailableDeliveryDates(address) : [],
        });
    } catch (err) {
        console.error('[delivery] error:', err);
        return res.status(500).json({ error: String(err.message || err) });
    }
});

async function getBigCommerceCheckout(cartId) {
    if (!cartId) return null;

    const response = await fetch(
        `${BIGCOMMERCE_API_URL}/stores/${BIGCOMMERCE_STORE_HASH}/v3/checkouts/${encodeURIComponent(cartId)}`,
        { headers: { Accept: 'application/json', 'X-Auth-Token': BIGCOMMERCE_ACCESS_TOKEN } },
    );

    if (!response.ok) {
        console.warn(`[shop-pay] checkout ${cartId} lookup failed with HTTP ${response.status}`);
        return null;
    }

    return (await response.json()).data || null;
}

// Signed-in shoppers own their cart, so its customer_id links the order to their
// account. Read it server-side rather than trusting a customer ID from the browser.
async function getBigCommerceCartCustomerId(cartId) {
    if (!cartId) return 0;

    try {
        const response = await fetch(
            `${BIGCOMMERCE_API_URL}/stores/${BIGCOMMERCE_STORE_HASH}/v3/carts/${encodeURIComponent(cartId)}`,
            { headers: { Accept: 'application/json', 'X-Auth-Token': BIGCOMMERCE_ACCESS_TOKEN } },
        );

        if (!response.ok) {
            console.warn(`[shop-pay] cart ${cartId} lookup failed with HTTP ${response.status}; creating a guest order`);
            return 0;
        }

        const cart = await response.json();

        return Number(cart.data?.customer_id) || 0;
    } catch (err) {
        console.warn(`[shop-pay] cart ${cartId} lookup failed; creating a guest order:`, err);
        return 0;
    }
}

async function createBigCommerceOrder(record, paymentRequest, billingAddress) {
    if (BIGCOMMERCE_CREATE_ORDER !== 'true' || record.bcOrderId) return null;
    if (!BIGCOMMERCE_STORE_HASH || !BIGCOMMERCE_ACCESS_TOKEN) {
        throw new Error('BigCommerce order creation is enabled but credentials are missing');
    }

    const products = [];
    for (const item of paymentRequest.lineItems || []) {
        const catalogResponse = await fetch(
            `${BIGCOMMERCE_API_URL}/stores/${BIGCOMMERCE_STORE_HASH}/v3/catalog/products?sku=${encodeURIComponent(item.sku || '')}`,
            { headers: { Accept: 'application/json', 'X-Auth-Token': BIGCOMMERCE_ACCESS_TOKEN } },
        );
        const catalog = await catalogResponse.json();
        const product = catalog.data?.[0];
        if (!product?.id) throw new Error(`BigCommerce product not found for SKU ${item.sku}`);
        products.push({ product_id: product.id, quantity: item.quantity });
    }

    const customerId = await getBigCommerceCartCustomerId(record.bcCartId);
    const shippingAddress = paymentRequest.shippingAddress || billingAddress || {};
    const shippingCost =
        paymentRequest.totalShippingPrice?.finalTotal?.amount ??
        paymentRequest.shippingLines?.[0]?.amount?.amount ??
        '0.00';
    const discountAmount = (paymentRequest.discounts || []).reduce(
        (sum, discount) => sum + Number(discount.amount?.amount || 0),
        0,
    );
    const response = await fetch(
        `${BIGCOMMERCE_API_URL}/stores/${BIGCOMMERCE_STORE_HASH}/v2/orders`,
        {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'X-Auth-Token': BIGCOMMERCE_ACCESS_TOKEN,
            },
            body: JSON.stringify({
                status_id: Number(BIGCOMMERCE_PAID_STATUS_ID),
                ...(customerId ? { customer_id: customerId } : {}),
                payment_method: 'Shop Pay',
                ...(record.scheduledDelivery
                    ? {
                          staff_notes: describeScheduledDelivery(
                              record.finalPaymentRequest?.shippingLines?.[0]?.label,
                              record.scheduledDelivery,
                          ),
                          customer_message: `Delivery date: ${record.scheduledDelivery.date}${record.scheduledDelivery.instructions ? `\nDelivery instructions: ${record.scheduledDelivery.instructions}` : ''}`,
                      }
                    : {}),
                billing_address: mapBigCommerceAddress(billingAddress || shippingAddress),
                shipping_addresses: [mapBigCommerceAddress(shippingAddress)],
                shipping_cost_ex_tax: String(shippingCost),
                shipping_cost_inc_tax: String(shippingCost),
                ...(discountAmount > 0 ? { discount_amount: String(discountAmount) } : {}),
                products,
            }),
        },
    );
    const order = await response.json();
    if (!response.ok) throw new Error(`BigCommerce order creation failed: ${JSON.stringify(order)}`);
    record.bcOrderId = order.id;
    await sessionStore.save(record);
    await reconcileBigCommerceOrder(record);
    record.status = 'bigcommerce_order_created';
    await sessionStore.save(record);
    return order.id;
}

app.post('/webhooks/shopify/orders', async (req, res) => {
    if (!verifyShopifyHmac(req)) return res.status(401).send('Invalid HMAC');

    const order = JSON.parse(req.body.toString('utf8'));
    // Shop Pay Wallet echoes our sourceIdentifier back on the order so we can link it.
    const sourceIdentifier = order.source_identifier || order.note_attributes?.find?.((a) => a.name === 'sourceIdentifier')?.value;

    const record = sourceIdentifier && (await sessionStore.get(sourceIdentifier));
    if (record) {
        if (record.shopifyOrderId && String(record.shopifyOrderId) === String(order.id)) {
            return res.status(200).send('ok');
        }

        record.shopifyOrderId = order.id;
        record.shopifyOrderName = order.name;
        record.financialStatus = order.financial_status;
        record.status = 'order_reconciled';
        await sessionStore.save(record);
        console.log(`[webhook] linked Shopify order ${order.name} (${order.financial_status}) -> BC cart ${record.bcCartId}`);
        try {
            await reconcileBigCommerceOrder(record);
        } catch (err) {
            console.error('[webhook] BigCommerce reconciliation error:', err);
            record.status = 'reconciliation_failed';
            await sessionStore.save(record);
        }
    } else {
        console.log(`[webhook] order ${order.name} with no matching sourceIdentifier=${sourceIdentifier}`);
    }
    res.status(200).send('ok');
});

app.get('/bigcommerce/orders/:id', async (req, res) => {
    try {
        const confirmationToken = req.get('X-Shop-Pay-Confirmation-Token');
        const record = await sessionStore.getByOrderId(req.params.id);
        if (
            !record ||
            !confirmationToken ||
            confirmationToken !== record.confirmationToken ||
            Date.now() - record.createdAt > CONFIRMATION_TOKEN_TTL_MS
        ) {
            return res.status(404).json({ error: 'Order confirmation not found' });
        }

        const response = await fetch(
            `${BIGCOMMERCE_API_URL}/stores/${BIGCOMMERCE_STORE_HASH}/v2/orders/${encodeURIComponent(record.bcOrderId)}`,
            { headers: { Accept: 'application/json', 'X-Auth-Token': BIGCOMMERCE_ACCESS_TOKEN } },
        );
        if (response.status === 404) return res.status(404).json({ error: 'BigCommerce order not found' });
        const order = await response.json();
        if (!response.ok) return res.status(response.status).json(order);
        const productsResponse = await fetch(
            `${BIGCOMMERCE_API_URL}/stores/${BIGCOMMERCE_STORE_HASH}/v2/orders/${order.id}/products`,
            { headers: { Accept: 'application/json', 'X-Auth-Token': BIGCOMMERCE_ACCESS_TOKEN } },
        );
        const products = productsResponse.ok ? await productsResponse.json() : [];
        await clearBigCommerceCart(record);

        return res.json({
            id: order.id,
            status: order.status,
            customer_name: [order.billing_address?.first_name, order.billing_address?.last_name]
                .filter(Boolean)
                .join(' '),
            customer_email: order.billing_address?.email || '',
            subtotal_inc_tax: order.subtotal_inc_tax,
            total_tax: order.total_tax,
            total_inc_tax: order.total_inc_tax,
            shipping_cost_inc_tax: order.shipping_cost_inc_tax,
            currency_code: order.currency_code,
            products,
        });
    } catch (err) {
        return res.status(500).json({ error: String(err.message || err) });
    }
});

// ---------------------------------------------------------------------------
// Debug + health
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ ok: true, shopId: SHOP_ID, endpoint: STOREFRONT_ENDPOINT }));

console.log(`[session-store] using ${sessionStoreKind}`);

app.listen(PORT, () => {
    console.log(`Shop Pay POC backend on http://localhost:${PORT}`);
    console.log(`Storefront endpoint: ${STOREFRONT_ENDPOINT}`);
});

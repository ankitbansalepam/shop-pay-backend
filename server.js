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
import express from 'express';
import cors from 'cors';

const {
    SHOP_DOMAIN,
    SHOP_ID,
    STOREFRONT_API_TOKEN,
    SHOPIFY_WEBHOOK_SECRET,
    SHOPIFY_API_VERSION = '2025-07',
    BIGCOMMERCE_STORE_HASH = '',
    BIGCOMMERCE_ACCESS_TOKEN = '',
    BIGCOMMERCE_API_URL = 'https://api.bigcommerce.com',
    BIGCOMMERCE_PAID_STATUS_ID = '11',
    BIGCOMMERCE_CREATE_ORDER = 'false',
    PORT = 8787,
    ALLOWED_ORIGIN = '',
} = process.env;

if (!SHOP_DOMAIN) console.warn('[warn] SHOP_DOMAIN is empty — set it in .env (e.g. your-store.myshopify.com)');
if (!STOREFRONT_API_TOKEN) console.warn('[warn] STOREFRONT_API_TOKEN is empty — session mutations will fail.');
if (!SHOPIFY_WEBHOOK_SECRET) console.warn('[warn] SHOPIFY_WEBHOOK_SECRET is empty — /webhooks/shopify/orders will reject every request with 401.');

const STOREFRONT_ENDPOINT = `https://${SHOP_DOMAIN}/api/${SHOPIFY_API_VERSION}/graphql.json`;

// POC "database": maps our sourceIdentifier -> what we know about the order.
// Replace with a real store (Redis/Postgres) beyond POC.
const orderMap = new Map();
const CONFIRMATION_TOKEN_TTL_MS = 15 * 60 * 1000;

function isFiniteNonNegative(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateCart(cart) {
    if (!cart || typeof cart !== 'object') return 'Cart is required';
    if (typeof cart.cartId !== 'string' || !cart.cartId.trim()) return 'cartId is required';
    if (typeof cart.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(cart.currencyCode)) {
        return 'currencyCode must be a three-letter uppercase code';
    }
    if (!Array.isArray(cart.lineItems) || cart.lineItems.length === 0) {
        return 'At least one cart line item is required';
    }
    if (cart.lineItems.length > 100) return 'Too many cart line items';
    if (!isFiniteNonNegative(cart.subtotal) || !isFiniteNonNegative(cart.total)) {
        return 'Cart subtotal and total must be non-negative numbers';
    }

    for (const item of cart.lineItems) {
        if (!item || typeof item.name !== 'string' || !item.name.trim()) return 'Each item needs a name';
        if (!Number.isInteger(item.quantity) || item.quantity <= 0) return 'Item quantities must be positive integers';
        if (!isFiniteNonNegative(item.listPrice) && !isFiniteNonNegative(item.salePrice)) {
            return 'Each item needs a valid price';
        }
    }

    return null;
}

function validateFinalPaymentRequest(paymentRequest, originalPaymentRequest) {
    const total = paymentRequest?.total;
    if (!total || !isFiniteNonNegative(Number(total.amount))) {
        return 'A valid final payment total is required';
    }
    if (total.currencyCode !== originalPaymentRequest.presentmentCurrency) {
        return 'Final payment currency does not match the session currency';
    }
    if (paymentRequest.totalTax && !isFiniteNonNegative(Number(paymentRequest.totalTax.amount))) {
        return 'Final tax amount is invalid';
    }
    if (paymentRequest.totalShippingPrice?.finalTotal &&
        !isFiniteNonNegative(Number(paymentRequest.totalShippingPrice.finalTotal.amount))) {
        return 'Final shipping amount is invalid';
    }
    return null;
}

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

        const existingRecord = orderMap.get(sourceIdentifier);
        if (existingRecord && existingRecord.status !== 'session_created') {
            return res.status(409).json({ error: 'This Shop Pay session has already been submitted' });
        }

        const paymentRequest = buildPaymentRequest(cart);

        const data = await storefront(CREATE, { paymentRequest, sourceIdentifier });
        const payload = data.shopPayPaymentRequestSessionCreate;

        if (payload.userErrors?.length) {
            return res.status(422).json({ userErrors: payload.userErrors });
        }

        const session = payload.shopPayPaymentRequestSession;
        // Remember what we sent, so /submit can resend the same paymentRequest.
        orderMap.set(sourceIdentifier, {
            bcCartId: cart.cartId,
            bcOrderId: req.body.bcOrderId || null,
            confirmationToken: crypto.randomBytes(32).toString('hex'),
            sourceIdentifier,
            token: session.token,
            paymentRequest,
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
        const record = orderMap.get(sourceIdentifier);
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

        record.status = 'submitted';
        record.receipt = payload.paymentRequestReceipt;
        record.finalPaymentRequest = paymentRequest;
        const bcOrderId = await createBigCommerceOrder(record, paymentRequest, billingAddress);
        const response = {
            receipt: payload.paymentRequestReceipt,
            bcOrderId: bcOrderId || record.bcOrderId || undefined,
            confirmationToken: record.confirmationToken,
        };
        record.submitResponse = response;
        return res.json(response);
    } catch (err) {
        console.error('[submit] error:', err);
        return res.status(500).json({ error: String(err.message || err) });
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
            return;
        }

        if (!response.ok && response.status !== 204) {
            const text = await response.text();
            throw new Error(`BigCommerce cart delete failed with HTTP ${response.status}: ${text}`);
        }

        record.cartCleared = true;
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
                payment_method: 'Shop Pay',
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
    await reconcileBigCommerceOrder(record);
    await clearBigCommerceCart(record);
    record.status = 'bigcommerce_order_created';
    return order.id;
}

app.post('/webhooks/shopify/orders', (req, res) => {
    if (!verifyShopifyHmac(req)) return res.status(401).send('Invalid HMAC');

    const order = JSON.parse(req.body.toString('utf8'));
    // Shop Pay Wallet echoes our sourceIdentifier back on the order so we can link it.
    const sourceIdentifier = order.source_identifier || order.note_attributes?.find?.((a) => a.name === 'sourceIdentifier')?.value;

    const record = sourceIdentifier && orderMap.get(sourceIdentifier);
    if (record) {
        record.shopifyOrderId = order.id;
        record.shopifyOrderName = order.name;
        record.financialStatus = order.financial_status;
        record.status = 'order_reconciled';
        console.log(`[webhook] linked Shopify order ${order.name} (${order.financial_status}) -> BC cart ${record.bcCartId}`);
        reconcileBigCommerceOrder(record).catch((err) => {
            console.error('[webhook] BigCommerce reconciliation error:', err);
            record.status = 'reconciliation_failed';
        });
    } else {
        console.log(`[webhook] order ${order.name} with no matching sourceIdentifier=${sourceIdentifier}`);
    }
    res.status(200).send('ok');
});

app.get('/bigcommerce/orders/:id', async (req, res) => {
    try {
        const confirmationToken = req.get('X-Shop-Pay-Confirmation-Token');
        const record = [...orderMap.values()].find(
            (entry) => entry.bcOrderId && String(entry.bcOrderId) === String(req.params.id),
        );
        if (
            !record ||
            !confirmationToken ||
            confirmationToken !== record.confirmationToken ||
            Date.now() - record.createdAt > CONFIRMATION_TOKEN_TTL_MS
        ) {
            return res.status(404).json({ error: 'Order confirmation not found' });
        }

        const response = await fetch(
            `${BIGCOMMERCE_API_URL}/stores/${BIGCOMMERCE_STORE_HASH}/v2/orders?limit=250`,
            { headers: { Accept: 'application/json', 'X-Auth-Token': BIGCOMMERCE_ACCESS_TOKEN } },
        );
        const orders = await response.json();
        if (!response.ok) return res.status(response.status).json(orders);
        const order = orders.find(({ id }) => String(id) === String(req.params.id));
        if (!order) return res.status(404).json({ error: 'BigCommerce order not found' });
        const productsResponse = await fetch(
            `${BIGCOMMERCE_API_URL}/stores/${BIGCOMMERCE_STORE_HASH}/v2/orders/${order.id}/products`,
            { headers: { Accept: 'application/json', 'X-Auth-Token': BIGCOMMERCE_ACCESS_TOKEN } },
        );
        const products = productsResponse.ok ? await productsResponse.json() : [];

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
app.get('/shop-pay/orders', (_req, res) => res.json([...orderMap.values()]));

app.listen(PORT, () => {
    console.log(`Shop Pay POC backend on http://localhost:${PORT}`);
    console.log(`Storefront endpoint: ${STOREFRONT_ENDPOINT}`);
});

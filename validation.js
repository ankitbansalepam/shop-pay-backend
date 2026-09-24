export function isFiniteNonNegative(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function validateCart(cart) {
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

export function validateFinalPaymentRequest(paymentRequest, originalPaymentRequest) {
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

// The amount Shopify will charge must equal BigCommerce's checkout total, which is
// computed server-side from the cart, selected shipping, discounts and tax.
export function validateTotalMatchesCheckout(paymentRequest, checkout) {
    const submitted = Number(paymentRequest?.total?.amount);
    const expected = Number(checkout?.grand_total);

    if (!Number.isFinite(expected)) return 'The BigCommerce checkout total is unavailable';
    // Allow one cent for rounding (e.g. 49.445 vs 49.45); anything larger is a real mismatch.
    if (!Number.isFinite(submitted) || Math.abs(submitted - expected) > 0.01 + 1e-9) {
        return 'The Shop Pay total does not match the BigCommerce checkout total';
    }
    return null;
}

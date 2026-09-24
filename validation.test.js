import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateCart, validateFinalPaymentRequest, validateTotalMatchesCheckout } from './validation.js';

const cart = {
    cartId: 'cart-1',
    currencyCode: 'USD',
    lineItems: [{ name: 'Oak Cheese Grater', quantity: 2, listPrice: 34.95, salePrice: 34.95 }],
    subtotal: 69.9,
    total: 76.89,
};

describe('validateCart', () => {
    it('accepts a valid cart', () => {
        assert.equal(validateCart(cart), null);
    });

    it('rejects a missing cart id', () => {
        assert.equal(validateCart({ ...cart, cartId: ' ' }), 'cartId is required');
    });

    it('rejects a lowercase currency code', () => {
        assert.match(validateCart({ ...cart, currencyCode: 'usd' }), /currencyCode/);
    });

    it('rejects an empty cart', () => {
        assert.match(validateCart({ ...cart, lineItems: [] }), /line item/);
    });

    it('rejects a fractional quantity', () => {
        assert.match(validateCart({ ...cart, lineItems: [{ ...cart.lineItems[0], quantity: 1.5 }] }), /quantities/);
    });

    it('rejects a negative total', () => {
        assert.match(validateCart({ ...cart, total: -1 }), /non-negative/);
    });
});

describe('validateFinalPaymentRequest', () => {
    const original = { presentmentCurrency: 'USD' };

    it('accepts a matching currency and valid amounts', () => {
        assert.equal(
            validateFinalPaymentRequest(
                {
                    total: { amount: '87.89', currencyCode: 'USD' },
                    totalShippingPrice: { finalTotal: { amount: '11' } },
                },
                original,
            ),
            null,
        );
    });

    it('rejects a different currency', () => {
        assert.match(
            validateFinalPaymentRequest({ total: { amount: '10', currencyCode: 'CAD' } }, original),
            /currency/,
        );
    });

    it('rejects an invalid shipping amount', () => {
        assert.match(
            validateFinalPaymentRequest(
                {
                    total: { amount: '10', currencyCode: 'USD' },
                    totalShippingPrice: { finalTotal: { amount: 'abc' } },
                },
                original,
            ),
            /shipping/,
        );
    });
});

describe('validateTotalMatchesCheckout', () => {
    const checkout = { grand_total: 87.89 };

    it('accepts a total equal to the BigCommerce checkout total', () => {
        assert.equal(validateTotalMatchesCheckout({ total: { amount: '87.89' } }, checkout), null);
    });

    it('accepts a total that differs only by rounding', () => {
        assert.equal(validateTotalMatchesCheckout({ total: { amount: '49.445' } }, { grand_total: 49.45 }), null);
    });

    it('rejects a total more than one cent lower', () => {
        assert.match(validateTotalMatchesCheckout({ total: { amount: '49.43' } }, { grand_total: 49.45 }), /does not match/);
    });

    it('rejects a lower total', () => {
        assert.match(validateTotalMatchesCheckout({ total: { amount: '76.89' } }, checkout), /does not match/);
    });

    it('rejects a missing total', () => {
        assert.match(validateTotalMatchesCheckout({}, checkout), /does not match/);
    });

    it('rejects when the checkout is unavailable', () => {
        assert.match(validateTotalMatchesCheckout({ total: { amount: '87.89' } }, null), /unavailable/);
    });
});

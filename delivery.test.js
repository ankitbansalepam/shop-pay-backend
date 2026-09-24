import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    getAvailableDeliveryDates,
    isScheduledProduct,
    validateScheduledDelivery,
} from './delivery.js';

// Thursday 24 September 2026.
const now = new Date('2026-09-24T12:00:00Z');
const address = { countryCode: 'US', postalCode: '43215' };

describe('getAvailableDeliveryDates', () => {
    it('starts two days out, skips Sundays and returns at most 10 dates', () => {
        const dates = getAvailableDeliveryDates(address, now);

        assert.equal(dates[0], '2026-09-26');
        assert.ok(!dates.includes('2026-09-27'), 'Sunday is excluded');
        assert.equal(dates.length, 10);
    });

    it('returns no dates for an ineligible country', () => {
        assert.deepEqual(getAvailableDeliveryDates({ countryCode: 'GB' }, now), []);
    });
});

describe('isScheduledProduct', () => {
    it('detects the delivery_type custom field', () => {
        assert.equal(isScheduledProduct({ custom_fields: [{ name: 'delivery_type', value: 'scheduled' }] }), true);
        assert.equal(isScheduledProduct({ custom_fields: [{ name: 'color', value: 'blue' }] }), false);
        assert.equal(isScheduledProduct({}), false);
    });
});

describe('validateScheduledDelivery', () => {
    it('accepts an available date', () => {
        assert.equal(validateScheduledDelivery({ date: '2026-09-26', instructions: 'Buzz 12' }, address, now), null);
    });

    it('rejects a missing choice, a Sunday and a malformed date', () => {
        assert.match(validateScheduledDelivery(undefined, address, now), /required/);
        assert.match(validateScheduledDelivery({ date: '2026-09-27' }, address, now), /not available/);
        assert.match(validateScheduledDelivery({ date: '29/09/2026' }, address, now), /invalid/);
    });
});

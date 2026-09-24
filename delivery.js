// Scheduled (truck) delivery: which carts need it, which services exist, and which dates
// are available. Dates come from a MOCK ATP until the real ATP API is integrated (SHP-15):
// replace getAvailableDeliveryDates() with a call to it.

// BigCommerce shipping method names that are scheduled-delivery services.
export const SCHEDULED_SERVICES = (process.env.SCHEDULED_DELIVERY_SERVICES || 'White Glove Delivery,Green Glove Delivery')
    .split(',')
    .map((service) => service.trim())
    .filter(Boolean);

// Product custom field that marks a product as needing scheduled delivery.
export const SCHEDULED_FIELD = { name: 'delivery_type', value: 'scheduled' };

const ELIGIBLE_COUNTRIES = (process.env.SCHEDULED_DELIVERY_COUNTRIES || 'US,CA')
    .split(',')
    .map((country) => country.trim().toUpperCase());
const LEAD_DAYS = 2;
const WINDOW_DAYS = 14;
const MAX_DATES = 10;

export function isEligibleAddress(address) {
    return Boolean(address?.countryCode) && ELIGIBLE_COUNTRIES.includes(String(address.countryCode).toUpperCase());
}

// MOCK ATP: weekdays and Saturdays from LEAD_DAYS ahead, within WINDOW_DAYS, at most
// MAX_DATES dates, as YYYY-MM-DD in UTC. Returns [] for ineligible addresses.
export function getAvailableDeliveryDates(address, now = new Date()) {
    if (!isEligibleAddress(address)) return [];

    const dates = [];
    for (let offset = LEAD_DAYS; offset <= WINDOW_DAYS && dates.length < MAX_DATES; offset += 1) {
        const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));

        if (day.getUTCDay() !== 0) dates.push(day.toISOString().slice(0, 10));
    }
    return dates;
}

export function isScheduledProduct(product) {
    return (product?.custom_fields || []).some(
        (field) =>
            String(field.name).trim().toLowerCase() === SCHEDULED_FIELD.name &&
            String(field.value).trim().toLowerCase() === SCHEDULED_FIELD.value,
    );
}

// Validates a shopper's scheduled delivery choice against the available dates.
export function validateScheduledDelivery(scheduledDelivery, address, now = new Date()) {
    if (!scheduledDelivery) return 'A delivery date is required for this cart';

    const { date, instructions = '' } = scheduledDelivery;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'The delivery date is invalid';
    if (typeof instructions !== 'string' || instructions.length > 500) return 'Delivery instructions are too long';
    if (!getAvailableDeliveryDates(address, now).includes(date)) {
        return 'The delivery date is not available for this address';
    }
    return null;
}

// Staff note for the BigCommerce order, e.g.
// "Scheduled delivery: Green Glove Delivery on Mon, Sep 28 (2026-09-28). Instructions: Buzz 12".
// The Shop Pay shipping line label already ends with " – <date>", so only the service is kept.
export function describeScheduledDelivery(shippingLineLabel, { date, instructions = '' }) {
    const service = String(shippingLineLabel || 'Scheduled delivery service').split(' – ')[0].trim();
    const day = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
    });

    return `Scheduled delivery: ${service} on ${day} (${date})${instructions ? `. Instructions: ${instructions}` : ''}`;
}

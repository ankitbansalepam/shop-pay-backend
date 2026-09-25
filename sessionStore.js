// Shop Pay session records, keyed by sourceIdentifier.
//
// With Upstash Redis configured (UPSTASH_REDIS_REST_URL/TOKEN, or the KV_REST_API_URL/TOKEN
// names the Vercel Marketplace integration adds), records are shared by every serverless
// instance. Without it, records fall back to a JSON file, which only suits a single
// long-running process: on Vercel each instance has its own /tmp, so a submit that lands on
// a different instance than the session fails with "Unknown sourceIdentifier".
import fs from 'node:fs';
import path from 'node:path';

const redisUrl = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;
const sessionKey = (sourceIdentifier) => `shop-pay:session:${sourceIdentifier}`;
const orderKey = (bcOrderId) => `shop-pay:order:${bcOrderId}`;
const metaKey = (name) => `shop-pay:meta:${name}`;
const PENDING_KEY = 'shop-pay:pending';

export const sessionStoreKind = redisUrl && redisToken ? 'upstash-redis' : 'file';

async function redis(command) {
    const response = await fetch(redisUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
    });
    const payload = await response.json();

    if (!response.ok || payload.error) {
        throw new Error(`Upstash Redis ${command[0]} failed: ${payload.error || response.status}`);
    }

    return payload.result;
}

function createFileStore(filePath) {
    const records = new Map();
    const locks = new Set();
    const meta = new Map();
    const pending = new Map();

    try {
        const entries = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        if (Array.isArray(entries)) {
            for (const [sourceIdentifier, record] of entries) {
                if (typeof sourceIdentifier === 'string' && record && typeof record === 'object') {
                    records.set(sourceIdentifier, record);
                }
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('[session-store] failed to load persisted sessions:', error);
        }
    }

    const persist = () => {
        const temporaryPath = `${filePath}.tmp`;

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(temporaryPath, JSON.stringify([...records.entries()], null, 2));
        fs.renameSync(temporaryPath, filePath);
    };

    return {
        async get(sourceIdentifier) {
            return records.get(sourceIdentifier) || null;
        },
        async save(record) {
            records.set(record.sourceIdentifier, record);
            persist();
        },
        async getByOrderId(bcOrderId) {
            return (
                [...records.values()].find((record) => String(record.bcOrderId) === String(bcOrderId)) || null
            );
        },
        async lock(name) {
            if (locks.has(name)) return false;
            locks.add(name);
            return true;
        },
        async unlock(name) {
            locks.delete(name);
        },
        async getJson(name) {
            return meta.get(name) ?? null;
        },
        async setJson(name, value) {
            meta.set(name, value);
        },
        async markPending(sourceIdentifier, submittedAt) {
            pending.set(sourceIdentifier, submittedAt);
        },
        async clearPending(sourceIdentifier) {
            pending.delete(sourceIdentifier);
        },
        async listPending() {
            return [...pending.entries()].map(([sourceIdentifier, submittedAt]) => ({ sourceIdentifier, submittedAt }));
        },
    };
}

const redisStore = {
    async get(sourceIdentifier) {
        const value = await redis(['GET', sessionKey(sourceIdentifier)]);

        return value ? JSON.parse(value) : null;
    },
    async save(record) {
        await redis(['SET', sessionKey(record.sourceIdentifier), JSON.stringify(record), 'EX', RECORD_TTL_SECONDS]);

        if (record.bcOrderId) {
            await redis(['SET', orderKey(record.bcOrderId), record.sourceIdentifier, 'EX', RECORD_TTL_SECONDS]);
        }
    },
    async getByOrderId(bcOrderId) {
        const sourceIdentifier = await redis(['GET', orderKey(bcOrderId)]);

        return sourceIdentifier ? this.get(sourceIdentifier) : null;
    },
    // Atomic across instances (SET NX); expires on its own if the holder crashes.
    async lock(name, ttlSeconds = 30) {
        return (await redis(['SET', `shop-pay:lock:${name}`, '1', 'NX', 'EX', ttlSeconds])) === 'OK';
    },
    async unlock(name) {
        await redis(['DEL', `shop-pay:lock:${name}`]);
    },
    async getJson(name) {
        const value = await redis(['GET', metaKey(name)]);

        return value ? JSON.parse(value) : null;
    },
    async setJson(name, value) {
        await redis(['SET', metaKey(name), JSON.stringify(value)]);
    },
    // Submitted payments without a BigCommerce order yet, scored by submit time.
    async markPending(sourceIdentifier, submittedAt) {
        await redis(['ZADD', PENDING_KEY, submittedAt, sourceIdentifier]);
    },
    async clearPending(sourceIdentifier) {
        await redis(['ZREM', PENDING_KEY, sourceIdentifier]);
    },
    async listPending() {
        const flat = (await redis(['ZRANGE', PENDING_KEY, 0, -1, 'WITHSCORES'])) || [];
        const entries = [];

        for (let index = 0; index < flat.length; index += 2) {
            entries.push({ sourceIdentifier: flat[index], submittedAt: Number(flat[index + 1]) });
        }
        return entries;
    },
};

export function createSessionStore(filePath) {
    return sessionStoreKind === 'upstash-redis' ? redisStore : createFileStore(filePath);
}

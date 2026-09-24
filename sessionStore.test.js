import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createSessionStore } from './sessionStore.js';

const tempStore = () =>
    createSessionStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shop-pay-')), 'sessions.json'));

describe('file session store', () => {
    it('saves records and finds them by BigCommerce order', async () => {
        const store = tempStore();

        await store.save({ sourceIdentifier: 'bc-1', bcOrderId: 42 });

        assert.equal((await store.get('bc-1')).bcOrderId, 42);
        assert.equal((await store.getByOrderId(42)).sourceIdentifier, 'bc-1');
        assert.equal(await store.get('missing'), null);
    });

    it('lets only one caller hold a lock until it is released', async () => {
        const store = tempStore();

        assert.equal(await store.lock('complete:bc-1'), true);
        assert.equal(await store.lock('complete:bc-1'), false);
        await store.unlock('complete:bc-1');
        assert.equal(await store.lock('complete:bc-1'), true);
    });
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootstrap } from '../src/index.js';

test('bootstrap placeholder', () => {
  assert.equal(bootstrap, true);
});

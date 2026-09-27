import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInstacartList, parseItems, providerHandoff, run } from './food-order.mjs';

test('provider handoffs use official sites and encode searches', () => {
  assert.equal(providerHandoff('doordash', 'tacos & salsa').url, 'https://www.doordash.com/search/store/tacos%20%26%20salsa/');
  assert.equal(providerHandoff('ubereats', 'sushi').url, 'https://www.ubereats.com/search?q=sushi');
  assert.equal(providerHandoff('instacart', 'milk').url, 'https://www.instacart.com/store/s?k=milk');
  assert.deepEqual(providerHandoff('gopuff', 'chips'), { name: 'Gopuff', query: 'chips', url: 'https://www.gopuff.com/search', searchOnSite: true });
  assert.throws(() => providerHandoff('other'), /Unknown provider/);
});

test('Instacart list sends documented payload and keeps key out of output', async () => {
  let request;
  const url = await createInstacartList(['milk', 'eggs'], {
    apiKey: 'test-secret',
    fetchImpl: async (endpoint, options) => {
      request = { endpoint, options };
      return { ok: true, json: async () => ({ products_link_url: 'https://www.instacart.com/store/list/123' }) };
    },
  });
  assert.equal(url, 'https://www.instacart.com/store/list/123');
  assert.equal(request.endpoint, 'https://connect.instacart.com/idp/v1/products/products_link');
  assert.equal(request.options.headers.Authorization, 'Bearer test-secret');
  assert.deepEqual(JSON.parse(request.options.body).line_items, [{ name: 'milk' }, { name: 'eggs' }]);
  assert.throws(() => parseItems([]), /1 to 50/);
  assert.throws(() => parseItems([' ']), /1 to 200/);
});

test('Instacart failures and unexpected URLs stop handoff', async () => {
  await assert.rejects(createInstacartList(['milk'], { apiKey: '' }), /INSTACART_API_KEY/);
  await assert.rejects(createInstacartList(['milk'], {
    apiKey: 'secret',
    fetchImpl: async () => ({ ok: false, status: 403 }),
  }), /HTTP 403/);
  await assert.rejects(createInstacartList(['milk'], {
    apiKey: 'secret',
    fetchImpl: async () => ({ ok: true, json: async () => ({ products_link_url: 'https://example.com/checkout' }) }),
  }), /unexpected shopping-list URL/);
});

test('CLI dry handoff does not launch browser', async () => {
  const messages = [];
  await run(['gopuff', 'snacks', '--no-open'], { write: (message) => messages.push(message), launch: () => assert.fail('browser launched') });
  assert.match(messages.join('\n'), /Search on site for: snacks/);
  assert.match(messages.join('\n'), /No order|Review availability/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { downsample } from '../../server/history.js';

test('downsample mantém pontos quando abaixo do limite', () => {
  const list = Array.from({ length: 10 }, (_, i) => ({ ts: String(i), v: i }));
  assert.equal(downsample(list, 720), list);
});

test('downsample reduz respeitando o limite e mantém o último ponto', () => {
  const list = Array.from({ length: 1000 }, (_, i) => ({ ts: String(i), v: i }));
  const out = downsample(list, 100);
  assert.ok(out.length <= 101);
  assert.equal(out[out.length - 1], list[list.length - 1]);
  assert.equal(out[0], list[0]);
});
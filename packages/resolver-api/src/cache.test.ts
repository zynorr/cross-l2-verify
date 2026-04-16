import test from "node:test";
import assert from "node:assert/strict";

import { LRUCache } from "./cache.js";

test("get returns undefined for missing keys", () => {
  const cache = new LRUCache<string, number>(3);
  assert.equal(cache.get("a"), undefined);
});

test("set and get round-trip", () => {
  const cache = new LRUCache<string, number>(3);
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
});

test("has returns true for present keys and false for absent keys", () => {
  const cache = new LRUCache<string, number>(3);
  assert.equal(cache.has("a"), false);
  cache.set("a", 1);
  assert.equal(cache.has("a"), true);
});

test("size tracks number of entries", () => {
  const cache = new LRUCache<string, number>(5);
  assert.equal(cache.size, 0);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.size, 2);
});

test("evicts the least-recently-used entry when over capacity", () => {
  const cache = new LRUCache<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);

  assert.equal(cache.has("a"), false, "oldest entry should be evicted");
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.size, 2);
});

test("accessing a key promotes it so a different entry is evicted", () => {
  const cache = new LRUCache<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);

  // Access "a" to promote it.
  cache.get("a");

  // Insert "c" — "b" should be evicted since "a" was recently accessed.
  cache.set("c", 3);

  assert.equal(cache.has("b"), false, "b should be evicted, not a");
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
});

test("overwriting a key does not increase size", () => {
  const cache = new LRUCache<string, number>(2);
  cache.set("a", 1);
  cache.set("a", 10);

  assert.equal(cache.size, 1);
  assert.equal(cache.get("a"), 10);
});

test("clear empties the cache", () => {
  const cache = new LRUCache<string, number>(3);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.clear();

  assert.equal(cache.size, 0);
  assert.equal(cache.has("a"), false);
});

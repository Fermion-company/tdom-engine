import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/reset-coordinator.js', import.meta.url), 'utf8');

function createCoordinator(options) {
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'reset-coordinator.js' });
  return new context.TdomDocumentResetCoordinator(options);
}

test('embedded reset cannot adopt until both host ack and engine completion', () => {
  const gate = createCoordinator({ hostRequired: true });
  assert.equal(gate.adopt(1), true);
  assert.equal(gate.acceptsReady(1), true);

  assert.equal(gate.begin(2), true);
  assert.equal(gate.acceptsReady(1), false);
  assert.equal(gate.complete(2), false);
  assert.equal(gate.adopt(2), false);

  assert.equal(gate.acknowledge(2), true);
  assert.equal(gate.canAdopt(2), true);
  assert.equal(gate.adopt(2), true);
  assert.equal(gate.acceptsReady(2), true);
});

test('a newer reset supersedes delayed acknowledgements from an older epoch', () => {
  const gate = createCoordinator({ hostRequired: true });
  gate.adopt(4);
  assert.equal(gate.begin(5), true);
  assert.equal(gate.begin(6), true);
  assert.equal(gate.acknowledge(5), false);
  assert.equal(gate.complete(5), false);
  assert.equal(gate.acknowledge(6), false);
  assert.equal(gate.complete(6), true);
  assert.equal(gate.adopt(6), true);
  assert.equal(gate.adopt(5), false);
});

test('standalone reset needs engine completion but no host acknowledgement', () => {
  const gate = createCoordinator();
  gate.adopt(1);
  assert.equal(gate.begin(2), true);
  assert.equal(gate.complete(2), true);
  assert.equal(gate.adopt(2), true);
});

'use strict';
// Retain this test path for historical references; ACL work now uses the native helper.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = path.resolve(__dirname, '../lib/platform/win32-update-store.js');
function fixture(run = () => true) {
  const originalRequire = createRequire(filename), calls = [], module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require(id) {
      if (id === './index') return { privateDirectory(home, create) { calls.push({home, create}); return run(home, create); } };
      if (id === 'node:child_process') assert.fail('separate PowerShell must not start');
      return originalRequire(id);
    },
  }, { filename });
  return { guard: module.exports.privateDirectory, calls };
}
test('each ACL request delegates once to the guarded native helper without cache or a shell', () => {
  const f = fixture(), home = 'C:\\recipient\\_hub\\run';
  f.guard(home, true); f.guard(home, false); f.guard(home, false);
  assert.deepEqual(f.calls, [{home,create:true},{home,create:false},{home,create:false}]);
});
test('native rejection propagates after one call without fallback or retry', () => {
  const error = Error('native path or ACL rejected'), f = fixture(() => { throw error; });
  assert.throws(() => f.guard('C:\\recipient\\updates', false), e => e === error);
  assert.equal(f.calls.length, 1);
});
test('only an explicit native success completes the ACL operation', () => {
  for (const result of [false, undefined, null, 'true', 'ok']) {
    const f = fixture(() => result);
    assert.throws(() => f.guard('C:\\recipient\\updates', true), /update_acl/);
    assert.equal(f.calls.length, 1);
  }
});

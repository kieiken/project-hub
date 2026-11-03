'use strict';
/**
 * @typedef {object} Platform
 * @property {string} name
 * @property {function(string, boolean=): Promise<object>} openTerminal
 * @property {function(number, boolean=): Promise<object>} focusTerminal
 * @property {function(string, boolean=): Promise<object>} openPath
 * @property {function(string, boolean=, object=): Promise<object>} revealPath
 * @property {function(string, boolean=): Promise<object>} openUrl
 * @property {function(string=, Function=): (Promise<string>|object)} pickFolder Empty on cancellation; callback preserves HTTP completion timing.
 * @property {function(): string} documentsDirectory Current user's OS Documents path; lookup only, no creation or HOME-based fallback.
 * @property {function(Function=): Promise<Array<object>>} listProcesses
 * @property {function(number[], object=): Promise<Map<number,string>>} processCwd
 * @property {function(Function=): Array<object>} processSnapshot Strong ownership identity.
 * @property {function(object): (number|string|undefined)} processOwner Native UID or nonempty Windows SID; never a display name.
 * @property {function(): (number|string|undefined)} currentProcessOwner Same native owner type as processOwner.
 * @property {object} persistence syncDirectory(dir), syncFile(file), withDirectorySync(dir, operation); Windows syncDirectory checks identity only, plus renameSync uses file flush/write-through move. Mac/Linux retain directory fsync; optional per-call IO for fixtures. Errors propagate, unsupported OS never succeeds.
 * @property {string[]} supervisorFiles All local JS dependencies needed by this OS's detached ownership code.
 * @property {function(number, Function=): string} processBirth Empty when unavailable.
 * @property {function(object, string|number=, object=): *} killTree
 * @property {function(): string[]} shellCandidates
 * @property {function(string, string): ?string} findExecutable
 * @property {function(string=): string} trashDir
 * @property {function(string, string=, object=): string} trashRootFor
 * @property {object} commandSandbox available(), profile(root, readFiles), spawn().
 * @property {function(object=): object} secretStore get/put/elapsed/watchResume.
 * @property {function(Function=): string} machineHint
 * @property {function(string, Function=): Promise<string>} readPdfText
 * @property {function(string): string} imageInfo
 * @property {function(string, string, object=): *} convertImage
 * @property {function(Buffer, string): Promise<string>} convertDocument
 * @property {object} appUpdater Native primitives; callers retain all approval gates.
 */
// Platform contract. UI operations return Promises (picker also accepts its
// legacy callback without holding the HTTP mutation); process scans return
// [{pid, ppid, since (ISO), command}], cwd lookups return Map<pid, path>.
// processSnapshot retains the stronger pgid/uid/start/comm identity used before
// signalling. killTree preserves each caller's explicit fallback policy.
// Other OS adapters must retain an equally strong owner/start/executable identity.
// The supervisor pins the complete declared file set at Hub startup. Include
// transitive local dependencies; ownership primitives must need only this set
// and Node built-ins (no live Hub modules or credentials).
// trashDir is a default only: HUB_TRASH and per-call overrides stay at callers.
// commandSandbox supplies availability/profile/spawn, never permission policy.
// secretStore supplies get/put/elapsed/watchResume; appUpdater supplies native
// inspection/build/DMG primitives, never update eligibility or authorization.
// Pass an adapter object via options.platform (or platformApi for legacy string
// options) to isolate tests. Unsupported native operations fail closed.
const darwin = require('./darwin');
const adapters = new Map([['darwin', darwin]]);
function forPlatform(value = process.platform) {
  if (value && typeof value === 'object') return value;
  if (!adapters.has(value)) adapters.set(value, value === 'win32' ? require('./win32').create() : darwin.create({ name: value }));
  return adapters.get(value);
}
// The pre-existing Linux process/trash helpers are retained by the factory;
// other systems have no native implementation. Windows dependencies load only
// when selected. The shared file-io facade also travels with each worker.
const selected = forPlatform();
const supervisorFiles = Object.freeze([...new Set(['index.js', 'darwin.js', 'persistence.js', ...selected.supervisorFiles, 'file-io.js'])]);
module.exports = { ...selected, supervisorFiles, forPlatform, createDarwin: options => darwin.create(options) };

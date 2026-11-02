"""Offline synthetic fixtures, including real pip under the human sandbox; no browser/network."""
import ast
import base64
import contextlib
import hashlib
import io
import json
import os
import shutil
from pathlib import Path
import stat
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib/muse'))
import extras


class SandboxedPip(unittest.TestCase):
    """Real venv, ensurepip and pip. Synthetic TTY/manifest, never a real menu."""
    worker = r'''
import contextlib,hashlib,io,json,os,pathlib,re,stat,subprocess,sys
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
import extras
bundle,root=map(pathlib.Path,sys.argv[2:4])
action,mode=sys.argv[4:6]
rows=json.loads((root/'rows.json').read_text())
target=root/('extras-venv' if action=='video' else 'extras-browser-venv')
temporary=root/(target.name+'-pip-tmp')
outside=root.parent/'outside-write'
try: outside.write_text('must be denied')
except PermissionError: pass
else: raise AssertionError('sandbox allows writes outside taskroot')
if mode.startswith('collision-'):
 kind=mode.split('-',1)[1]
 sentinel=root/'keep'; sentinel.write_text('preserve')
 if kind=='directory':
  temporary.mkdir(mode=0o700); (temporary/'keep').write_text('preserve')
 elif kind=='file': temporary.write_text('preserve')
 else: temporary.symlink_to(sentinel)
 before=temporary.lstat()
observed=[]
real_run=subprocess.run
def run(argv,**kw):
 if '-m' in argv and argv[argv.index('-m')+1]=='pip':
  assert not mode.startswith('collision-'), 'pip must not run on collision'
  env=kw['env']
  assert {k:v for k,v in env.items() if k.startswith('PIP_')}=={
   'PIP_NO_CACHE_DIR':'1','PIP_NO_INDEX':'1','PIP_CONFIG_FILE':os.devnull}
  assert pathlib.Path(env['TMPDIR'])==temporary
  assert temporary.parent==root and not temporary.is_symlink()
  assert stat.S_IMODE(temporary.stat().st_mode)==0o700
  assert '--no-index' in argv and '--require-hashes' in argv
  if action=='browser': assert env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD']=='1'
  observed.append(str(temporary))
  if mode=='no-tmp': kw['env']={k:v for k,v in env.items() if k!='TMPDIR'}
  result=real_run([*argv,'-vv'],**kw)
  created=re.findall(r'Created temporary directory: (.+)',result.stdout.decode())
  assert created and all(pathlib.Path(p).is_relative_to(temporary) for p in created)
  return result
 return real_run(argv,**kw)
out=io.StringIO()
def answer(_): return out.getvalue().split('確認番号: ')[-1].strip()
error=None
with contextlib.ExitStack() as stack:
 stack.enter_context(patch.object(extras,'manifest',return_value={'wheels':rows}))
 stack.enter_context(patch.object(extras.subprocess,'run',side_effect=run))
 for stream in (sys.stdin,sys.stderr,out):
  stack.enter_context(patch.object(stream,'isatty',return_value=True))
 stack.enter_context(contextlib.redirect_stdout(out))
 try:
  (extras.install_video if action=='video' else extras.install_browser)(bundle,root,answer)
 except subprocess.CalledProcessError as exc:
  assert mode=='no-tmp', exc.stderr.decode()
  assert b'No usable temporary directory' in exc.stderr, exc.stderr.decode()
  error='no usable temporary directory'
 except FileExistsError:
  assert mode.startswith('collision-')
  error='existing temporary refused'
if mode=='no-tmp':
 assert error and temporary.is_dir() and not (target/'hub-ready.json').exists()
 assert not (target/'lib/python3.12/site-packages/yt_dlp').exists()
elif mode.startswith('collision-'):
 assert error and not observed and not target.exists()
 assert temporary.lstat().st_ino==before.st_ino and sentinel.read_text()=='preserve'
 assert (temporary/'keep').read_text()=='preserve' if kind=='directory' else temporary.read_text()=='preserve'
else:
 assert error is None and not temporary.exists()
 site=target/'lib/python3.12/site-packages'
 expected=rows[:1] if action=='video' else rows[1:]
 for row in expected:
  assert (site/row['name'].replace('-','_')/'__init__.py').read_text()=='VALUE = 42\n'
 assert (target/'hub-ready.json').is_file()
 (extras.interpreter if action=='video' else extras.browser_interpreter)(bundle,root)
assert len(observed)==(0 if mode.startswith('collision-') else 1)
print(json.dumps({'action':action,'mode':mode,'pip_calls':len(observed),'result':error or 'installed'}))
'''

    def setUp(self):
        self.workspace = extras.HERE.parents[2]
        self.bundle = self.workspace / '.ai/work/metamuse-local-20261024'
        self.tmp = tempfile.TemporaryDirectory(prefix='muse-pip-sandbox-', dir=self.workspace / '.ai/work')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.root.chmod(0o700)

    def wheel(self, staged, name):
        normalized = name.replace('-', '_')
        info = normalized + '-1.0.dist-info/'
        files = {normalized + '/__init__.py': b'VALUE = 42\n',
                 info + 'METADATA': ('Metadata-Version: 2.1\nName: ' + name + '\nVersion: 1.0\n').encode(),
                 info + 'WHEEL': b'Wheel-Version: 1.0\nGenerator: synthetic\nRoot-Is-Purelib: true\nTag: py3-none-any\n'}
        record = ''.join(n + ',sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode() + ',' + str(len(data)) + '\n'
                         for n, data in files.items()) + info + 'RECORD,,\n'
        files[info + 'RECORD'] = record.encode()
        path = staged / (normalized + '-1.0-py3-none-any.whl')
        with zipfile.ZipFile(path, 'w') as archive:
            for n, data in files.items(): archive.writestr(n, data)
        path.chmod(0o600)
        raw = path.read_bytes()
        return {'name': name, 'version': '1.0', 'filename': path.name,
                'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}

    def run_install(self, action, mode):
        root = self.root / (action + '-' + mode)
        root.mkdir(mode=0o700)
        staged = root / 'extras-wheels'; staged.mkdir(mode=0o700)
        rows = [self.wheel(staged, name) for name in ('yt-dlp', *extras.BROWSER_NAMES)]
        (root / 'rows.json').write_text(json.dumps(rows))
        params = {'bundle': self.bundle, 'bridge': extras.HERE, 'private': self.root,
                  'taskroot': root, 'taskparent': self.root, 'project': self.root}
        cmd = ['/usr/bin/sandbox-exec']
        for name, value in params.items(): cmd += ['-D', name + '=' + str(value)]
        cmd += ['-f', str(extras.HERE / 'hub-human.sb'), str(self.bundle / '.venv/bin/python'),
                '-I', '-B', '-c', self.worker, str(extras.HERE), str(self.bundle), str(root), action, mode]
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8', 'TZ': 'UTC',
               'PYTHONDONTWRITEBYTECODE': '1', 'OTEL_SDK_DISABLED': 'true', 'DO_NOT_TRACK': '1', 'NO_COLOR': '1',
               'PIP_CONSTRAINT': '/synthetic-inherited-must-not-be-read', 'PIP_CACHE_DIR': '/synthetic-cache'}
        result = subprocess.run(cmd, env=env, cwd=self.bundle, capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value['result'], {'ok': 'installed', 'no-tmp': 'no usable temporary directory'}.get(mode, 'existing temporary refused'))
        self.assertFalse((self.root / 'outside-write').exists())

    def test_video_real_pip_failure_retained_and_success_cleaned(self):
        for mode in ('no-tmp', 'ok'):
            with self.subTest(mode=mode): self.run_install('video', mode)

    def test_browser_real_pip_failure_retained_and_success_cleaned(self):
        for mode in ('no-tmp', 'ok'):
            with self.subTest(mode=mode): self.run_install('browser', mode)

    def test_existing_temporary_directory_file_or_link_is_never_reused(self):
        for action in ('video', 'browser'):
            for kind in ('directory', 'file', 'link'):
                with self.subTest(action=action, kind=kind):
                    self.run_install(action, 'collision-' + kind)


class EnvironmentRecovery(unittest.TestCase):
    """Real stdlib venv/ensurepip; only synthetic wheel installation is stubbed."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='muse-env-recovery-', dir='/private/tmp')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.bundle = self.root / 'bundle'
        base = self.bundle / '.venv/bin/python'
        base.parent.mkdir(parents=True)
        base.symlink_to(Path(sys._base_executable).resolve())
        self.taskroot = self.root / 'task'
        self.taskroot.mkdir(mode=0o700)
        self.target = self.taskroot / 'extras-venv'

    def copied_partial(self):
        extras.venv.EnvBuilder(with_pip=False, symlinks=False).create(self.target)
        self.target.chmod(0o700)
        (self.target / 'lib/python3.12/site-packages/pip').mkdir()
        self.assertFalse((self.target / 'bin/python').is_symlink())
        with self.assertRaisesRegex(ValueError, 'not the fixed Python'):
            extras.validate_runtime(self.bundle, self.target)

    def approve(self, value=True, reader=None):
        # Synthetic TTY only. Nothing accesses a real terminal/private task.
        out = io.StringIO()
        def answer(_):
            return out.getvalue().split('確認番号: ')[-1].strip() if value else 'decline'
        with contextlib.ExitStack() as stack:
            for stream in (sys.stdin, sys.stdout, sys.stderr):
                stack.enter_context(patch.object(stream, 'isatty', return_value=True))
            stack.enter_context(contextlib.redirect_stdout(out))
            # redirect_stdout replaces the already-patched stream.
            stack.enter_context(patch.object(out, 'isatty', return_value=True))
            return extras.preserve_incomplete_video(self.bundle, self.taskroot, reader or answer)

    def test_real_generation_video_and_browser_with_fixed_links(self):
        staged = self.taskroot / 'extras-wheels'; staged.mkdir(mode=0o700)
        rows = []
        for name in ('yt-dlp', *extras.BROWSER_NAMES):
            raw = ('synthetic-' + name).encode()
            row = {'name': name, 'version': 'synthetic', 'filename': name + '.whl',
                   'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
            rows.append(row)
            p = staged / row['filename']; p.write_bytes(raw); p.chmod(0o600)
        original_run = subprocess.run
        def run(argv, **kw):
            if '-m' in argv and argv[argv.index('-m') + 1] == 'pip':
                self.assertIn('--no-index', argv)
                self.assertIn('--require-hashes', argv)
                return SimpleNamespace(returncode=0)
            return original_run(argv, **kw)  # real stdlib ensurepip, no downloads
        with patch.object(extras, 'manifest', return_value={'wheels': rows}), \
                patch.object(extras.subprocess, 'run', side_effect=run), \
                patch.object(sys.stdin, 'isatty', return_value=True), \
                patch.object(sys.stdout, 'isatty', return_value=True), \
                patch.object(sys.stderr, 'isatty', return_value=True), \
                contextlib.redirect_stdout(io.StringIO()):
            digest = hashlib.sha256(json.dumps(rows[0], sort_keys=True).encode()).hexdigest()
            # stdout is redirected; explicitly mark that synthetic stream as TTY.
            with patch.object(sys.stdout, 'isatty', return_value=True):
                extras.install_video(self.bundle, self.taskroot, lambda _: digest)
                with patch.object(extras, '_approve', return_value=True):
                    extras.install_browser(self.bundle, self.taskroot)
        for name in ('extras-venv', 'extras-browser-venv'):
            target = self.taskroot / name
            self.assertTrue((target / 'bin/python').is_symlink())
            self.assertEqual(extras.validate_runtime(self.bundle, target).resolve(), Path(sys._base_executable).resolve())
        self.assertEqual(extras.interpreter(self.bundle, self.taskroot), self.target / 'bin/python')
        extras.browser_interpreter(self.bundle, self.taskroot)
        # Tampering is still rejected; matching bytes at another path are NOT a runtime.
        (self.target / 'bin/python').unlink()
        shutil.copyfile(sys._base_executable, self.target / 'bin/python')
        with self.assertRaisesRegex(ValueError, 'not the fixed Python'):
            extras.interpreter(self.bundle, self.taskroot)

    def test_copied_partial_preserved_then_fresh_generation_without_overwrite(self):
        self.copied_partial()
        tree = extras._tree(self.target)
        result = self.approve()
        backup = Path(result['preserved'])
        self.assertFalse(self.target.exists())
        self.assertEqual(extras._tree(backup), tree)
        self.assertFalse(result['installed'])
        extras.venv.EnvBuilder(with_pip=True, symlinks=True).create(self.target)
        self.target.chmod(0o700)
        extras.validate_runtime(self.bundle, self.target)
        self.assertEqual(extras._tree(backup), tree)
        # A freshly generated but unrecorded environment must not run tasks.
        with self.assertRaises(FileNotFoundError): extras.interpreter(self.bundle, self.taskroot)

    def test_refusal_cancel_non_tty_and_no_automatic_retry(self):
        self.copied_partial()
        before = extras._tree(self.target)
        self.assertEqual(self.approve(False), {'cancelled': True})
        with patch.object(sys.stdin, 'isatty', return_value=False):
            with self.assertRaisesRegex(ValueError, 'human terminal'):
                extras.preserve_incomplete_video(self.bundle, self.taskroot)
        self.assertEqual(extras._tree(self.target), before)
        self.assertEqual(list(self.taskroot.glob('extras-venv-incomplete-*')), [])

    def test_changed_during_approval_and_recorded_or_unsafe_env_refused(self):
        self.copied_partial()
        def mutate(*_):
            (self.target / 'changed').write_text('after approval')
            return True
        with patch.object(extras, '_approve', side_effect=mutate):
            with self.assertRaisesRegex(ValueError, 'changed after approval'):
                extras.preserve_incomplete_video(self.bundle, self.taskroot)
        self.assertEqual(list(self.taskroot.glob('extras-venv-incomplete-*')), [])
        for bad in ('receipt', 'foreign-python', 'linked-file', 'unsafe-mode'):
            with self.subTest(bad=bad), patch.object(extras, '_approve', side_effect=AssertionError('must reject before approval')):
                path = self.target / 'hub-ready.json' if bad == 'receipt' else self.target / 'bad'
                if bad == 'receipt': path.write_text('{}')
                elif bad == 'foreign-python':
                    path = self.target / 'bin/python'; old = path.read_bytes(); path.write_bytes(b'foreign')
                elif bad == 'linked-file': path.symlink_to(self.bundle / '.venv/bin/python')
                else: self.target.chmod(0o777)
                try:
                    with self.assertRaises(ValueError): extras.preserve_incomplete_video(self.bundle, self.taskroot)
                finally:
                    if bad == 'foreign-python': path.write_bytes(old)
                    elif bad == 'unsafe-mode': self.target.chmod(0o700)
                    else: path.unlink()
        self.assertTrue(self.target.is_dir())

    def test_existing_backup_and_rename_failure_preserve_original(self):
        self.copied_partial()
        before = extras._tree(self.target)
        existing = self.taskroot / ('extras-venv-incomplete-' + 'a' * 32)
        existing.mkdir(mode=0o700)
        sentinel = existing / 'keep'; sentinel.write_text('preserve')
        with patch('uuid.uuid4', return_value=SimpleNamespace(hex='a' * 32)):
            with self.assertRaises(FileExistsError): self.approve()
        self.assertEqual(sentinel.read_text(), 'preserve')
        self.assertEqual(extras._tree(self.target), before)
        with patch.object(Path, 'rename', side_effect=OSError('synthetic disk failure')):
            with self.assertRaisesRegex(OSError, 'disk failure'): self.approve()
        self.assertEqual(extras._tree(self.target), before)


def archive(entries):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        for name, data, mode in entries:
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = mode << 16
            z.writestr(info, data)
    return out.getvalue()


class Metadata(unittest.TestCase):
    """Narrow literal bundle fixtures for the pinned Playwright CfT layout."""
    prefix = 'playwright/driver/package/'
    bundle = '''function calculatePlatform() {
    let macPlatform = "mac" + macVersion;
    if (macVersion >= 11 && import_os3.default.cpus().some((cpu) => cpu.model.includes("Apple"))) {
      macPlatform += "-arm64";
    }
    return { hostPlatform: macPlatform, isOfficiallySupportedPlatform: macVersion >= 14 };
}
function cftUrl(suffix) {
  return ({ browserVersion }) => {
    return {
      path: `builds/cft/${browserVersion}/${suffix}`,
      mirrors: [
        "https://cdn.playwright.dev"
      ]
    };
  };
}
    EXECUTABLE_PATHS = {
      "chromium": {
        "<unknown>": void 0,
        "mac-arm64": ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"]
      },
      "chromium-headless-shell": {
        "mac-arm64": ["unrelated", "headless-shell"]
      }
    };
    DOWNLOAD_PATHS = {
      "chromium": {
        "mac13-arm64": void 0,
        "mac14-arm64": cftUrl("mac-arm64/chrome-mac-arm64.zip"),
        "mac15-arm64": cftUrl("mac-arm64/chrome-mac-arm64.zip"),
        "mac26-arm64": cftUrl("mac-arm64/chrome-mac-arm64.zip")
      },
      "chromium-headless-shell": {
        "mac14-arm64": cftUrl("mac-arm64/chrome-headless-shell-mac-arm64.zip")
      }
    };
'''
    browsers = '{"browsers":[{"name":"chromium","revision":"1243","browserVersion":"153.0.8010.12"}]}'

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.root.chmod(0o700)
        self.path = self.root / 'playwright.whl'

    def tearDown(self):
        self.tmp.cleanup()

    def read(self, bundle=None, browsers=None, extra=()):
        entries = [(self.prefix + 'browsers.json', self.browsers if browsers is None else browsers, 0o100664),
                   (self.prefix + 'lib/coreBundle.js', self.bundle if bundle is None else bundle, 0o100664), *extra]
        raw = archive(entries)
        self.path.write_bytes(raw); self.path.chmod(0o600)
        self.row = {'filename': self.path.name, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw), 'url': 'https://fixture.invalid/playwright.whl'}
        return extras._metadata(extras.validate_wheel(self.path, self.row), self.row)

    def test_cft_data_only_provenance_and_scoped_browser(self):
        # Fail if the read-only code tries to run code, approve or access a lock.
        with patch.object(extras.subprocess, 'run', side_effect=AssertionError('package execution')), patch.object(extras, '_approve', side_effect=AssertionError('approval')), patch.object(extras, '_core', side_effect=AssertionError('private lock')):
            result = self.read()
        self.assertEqual(result['version'], '153.0.8010.12')
        self.assertEqual(result['revision'], '1243')
        self.assertEqual(result['url'], 'https://cdn.playwright.dev/builds/cft/153.0.8010.12/mac-arm64/chrome-mac-arm64.zip')
        self.assertEqual(result['host_platforms'], ['mac14-arm64', 'mac15-arm64', 'mac26-arm64'])
        self.assertEqual(result['executable_relative_path'], 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
        self.assertEqual(result['sources'], {self.prefix + 'browsers.json': hashlib.sha256(self.browsers.encode()).hexdigest(), self.prefix + 'lib/coreBundle.js': hashlib.sha256(self.bundle.encode()).hexdigest()})
        self.assertEqual(result['wheel_sha256'], self.row['sha256'])
        self.assertIsNone(result['bytes']); self.assertIsNone(result['sha256'])
        self.assertEqual(list(self.root.iterdir()), [self.path])

    def test_metadata_permission_exception_never_extracts(self):
        self.read()
        with zipfile.ZipFile(self.path) as z:
            self.assertEqual(len(extras._zip_entries(z, metadata_only=True)), 2)
            with self.assertRaisesRegex(ValueError, 'permissions'): extras._zip_entries(z)
        for mode, name in [(0o100666, 'other'), (0o104664, 'setid'), (0o120777, 'link'), (0o010644, 'fifo'), (0o040775, 'directory/')]:
            with self.subTest(mode=mode), self.assertRaises(ValueError): self.read(extra=[(name, b'x', mode)])

    def test_ambiguous_or_unknown_bundle_is_rejected(self):
        variants = [self.bundle + self.bundle,
                    self.bundle.replace('builds/cft/${browserVersion}', 'builds/cft/${revision}'),
                    self.bundle.replace('https://cdn.playwright.dev', 'https://untrusted.invalid'),
                    self.bundle.replace('mac-arm64/chrome-mac-arm64.zip', 'mac-arm64/chrome-headless-shell-mac-arm64.zip'),
                    self.bundle.replace('"mac15-arm64": cftUrl', '"mac14-arm64": cftUrl'),
                    self.bundle.replace('"mac14-arm64": cftUrl', '"mac14-arm64": otherFunction'),
                    self.bundle.replace('"Google Chrome for Testing.app"', '"../escape"'),
                    self.bundle.replace('macPlatform += "-arm64";', 'macPlatform += "-x64";'),
                    self.bundle.replace('      "chromium-headless-shell": {', '      "chromium": {'),
                    self.bundle.replace('    DOWNLOAD_PATHS = {', '    DOWNLOAD_PATHS = { /* unknown syntax */')]
        for index, bundle in enumerate(variants):
            with self.subTest(index=index), self.assertRaises(ValueError): self.read(bundle=bundle)

    def test_manifest_ambiguity_overrides_types_and_mixed_layout(self):
        for manifest in ['{"browsers":[],"browsers":[]}', '{"browsers":[null]}',
                         self.browsers.replace('"revision":"1243"', '"revision":"1243","revision":"2"'),
                         self.browsers.replace('"revision":"1243"', '"revision":1243'),
                         self.browsers.replace('153.0.8010.12', '../escape'),
                         self.browsers.replace('"revision":"1243"', '"revision":"1243","revisionOverrides":{"mac14-arm64":"999"}'),
                         self.browsers.replace(']}', ',' + json.dumps(json.loads(self.browsers)['browsers'][0]) + ']}')]:
            with self.subTest(manifest=manifest), self.assertRaises(ValueError): self.read(browsers=manifest)
        for name in ['lib/server/registry/index.js', 'lib/server/utils/hostPlatform.js']:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'source layout'): self.read(extra=[(self.prefix + name, b'x', 0o100644)])
        with self.assertRaises(ValueError): self.read(bundle='unknown layout')

    def test_all_zip_entries_checked_before_metadata(self):
        for name in ['../escape', '/absolute', 'a\\b', 'a\n', 'HUB-READY.JSON', self.prefix + 'browsers.json']:
            with self.subTest(name=name), self.assertRaises(ValueError): self.read(extra=[(name, b'x', 0o100664)])
        for names in [('A', 'a'), ('é', 'e\u0301'), ('a', 'a/b')]:
            with self.subTest(names=names), self.assertRaises(ValueError): self.read(extra=[(n, b'x', 0o100664) for n in names])
        with patch.object(extras, 'MAX_ZIP_ENTRIES', 1), self.assertRaisesRegex(ValueError, 'count'): self.read()
        with zipfile.ZipFile(io.BytesIO(archive([('large', b'123', 0o100664)]))) as z:
            with self.assertRaisesRegex(ValueError, 'expansion'): extras._zip_entries(z, limit=2, metadata_only=True)

    def test_metadata_resource_extra_and_encryption_guards(self):
        with self.assertRaisesRegex(ValueError, 'oversize'): self.read(bundle='x' * (4 * 1024 * 1024 + 1))
        compressed = io.BytesIO()
        with zipfile.ZipFile(compressed, 'w', compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr('compressed', b'0' * (2 * 1024 * 1024))
        with zipfile.ZipFile(io.BytesIO(compressed.getvalue())) as z:
            with self.assertRaisesRegex(ValueError, 'expansion'): extras._zip_entries(z, metadata_only=True)
        raw = archive([('aXtail', b'x', 0o100664)]).replace(b'aXtail', b'a\x00tail')
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            with self.assertRaisesRegex(ValueError, 'control'): extras._zip_entries(z, metadata_only=True)
        for extra, flags in [(b'\x0d\x00\x00\x00', 0), (b'\x6e\x75\x00\x00', 0), (b'x', 0), (b'', 1)]:
            with self.subTest(extra=extra, flags=flags), zipfile.ZipFile(io.BytesIO(archive([('a', b'x', 0o100664)]))) as z:
                z.infolist()[0].extra = extra
                z.infolist()[0].flag_bits = flags
                with self.assertRaises(ValueError): extras._zip_entries(z, metadata_only=True)

    def test_derived_executable_and_sources_fixed_through_archive_approval(self):
        result = self.read()
        staged = self.root / 'extras-wheels'; staged.mkdir(mode=0o700)
        self.path.rename(staged / self.row['filename'])
        value = {'product_lock_sha256': hashlib.sha256((extras.HERE / 'extras-lock.json').read_bytes()).hexdigest(), 'chromium': result}
        lock = self.root / 'extras-lock.json'; lock.write_text(json.dumps(value)); lock.chmod(0o600)
        candidate = {'url': result['url'], 'sha256': 'a'*64, 'bytes': 42, 'executable_relative_path': 'other/executable'}
        with patch.object(extras, 'manifest', return_value={'wheels': [{**self.row, 'name': 'playwright'}]}), patch.object(extras, '_core'), patch.object(extras, '_approve', return_value=False) as approve:
            with self.assertRaisesRegex(ValueError, 'executable differs'): extras.approve_browser_archive(self.root, candidate)
            approve.assert_not_called()
            candidate['executable_relative_path'] = result['executable_relative_path']
            self.assertEqual(extras.approve_browser_archive(self.root, candidate), {'cancelled': True})
            for key, replacement in [('executable_relative_path', 'other/executable'), ('host_platforms', ['mac99-arm64']), ('sources', {})]:
                changed = {**value, 'chromium': {**result, key: replacement}}
                lock.write_text(json.dumps(changed))
                with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'changed'): extras._local_lock(self.root)

    def test_cft_archive_staging_uses_derived_filename(self):
        result = self.read()
        staged = self.root / 'extras-wheels'; staged.mkdir(mode=0o700)
        self.path.rename(staged / self.row['filename'])
        raw = archive([(result['executable_relative_path'], b'fixture, never executed', 0o100755)])
        archives = self.root / 'extras-archives'; archives.mkdir(mode=0o700)
        path = archives / 'chrome-mac-arm64.zip'; path.write_bytes(raw); path.chmod(0o600)
        approved = {**result, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
        lock = self.root / 'extras-lock.json'
        lock.write_text(json.dumps({'product_lock_sha256': hashlib.sha256((extras.HERE / 'extras-lock.json').read_bytes()).hexdigest(), 'chromium': approved})); lock.chmod(0o600)
        with patch.object(extras, 'manifest', return_value={'wheels': [{**self.row, 'name': 'playwright'}]}), patch.object(extras, '_core') as core, patch.object(extras, '_facebook_runtime'), patch.object(extras, '_approve', return_value=True):
            self.assertEqual(extras.install_browser_archive(self.root)['installed'], 'chromium')
            core.return_value.save.assert_called_once()
        executable = self.root / 'extras-browser' / result['executable_relative_path']
        self.assertEqual(executable.read_bytes(), b'fixture, never executed')
        # Exercise the actual human-menu routing without importing its runtime.
        tree = ast.parse((extras.HERE / 'hub_core.py').read_text())
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == 'install_browser_archive']
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(calls[0].args), 1)
        self.assertEqual([n.arg for n in calls[0].keywords], ['reader'])


class Extras(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.root.chmod(0o700)
        self.staged = self.root / 'extras-wheels'
        self.staged.mkdir(mode=0o700)
        self.bundle = self.root / 'bundle'
        fixed = self.bundle / '.venv/bin/python'
        fixed.parent.mkdir(parents=True)
        fixed.write_bytes(b'never executed')
        self.rows = []
        sources = [('playwright/driver/package/browsers.json', json.dumps({'browsers': [{'name':'chromium','revision':'123','browserVersion':'1.2.3.4'}]}).encode(), 0o100644),
                   ('playwright/driver/package/lib/server/registry/index.js', b"const x = {'mac-arm64': 'builds/chromium/%s/chromium-mac-arm64.zip'}; const cdn='https://cdn.playwright.dev/dbazure/download/playwright';", 0o100644),
                   ('playwright/driver/package/lib/server/utils/hostPlatform.js', b"const arch='arm64'; const host='mac14-';", 0o100644)]
        for name in extras.BROWSER_NAMES:
            raw = archive(sources) if name == 'playwright' else b'fixture'
            path = self.staged / (name + '.whl')
            path.write_bytes(raw); path.chmod(0o600)
            self.rows.append({'name':name,'version':'1','filename':path.name,'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'url':'https://fixture.invalid/'+path.name})
        tree = ast.parse((extras.HERE / 'hub_core.py').read_text())
        selected = ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ('checked', 'save', 'private_dir')], type_ignores=[])
        namespace = {'Path': Path, 'os': os, 'stat': stat}
        exec(compile(selected, '<core filesystem helpers>', 'exec'), namespace)
        core = SimpleNamespace(**{n: namespace[n] for n in ('checked', 'save', 'private_dir')})
        self.patches = [patch.object(extras, '_facebook_runtime'), patch.object(extras, '_core', return_value=core), patch.object(extras, 'manifest', return_value={'wheels': self.rows})]
        self.patches += [patch.object(s, 'isatty', return_value=True) for s in (sys.stdin,sys.stdout,sys.stderr)]
        for p in self.patches: p.start()

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.tmp.cleanup()

    def approve(self, value, reader): return True

    def derive(self):
        with patch.object(extras, '_approve', side_effect=self.approve):
            return extras.derive_browser_metadata(self.root)

    def environment(self, target):
        (target / 'lib/python3.12/site-packages').mkdir(parents=True)
        (target / 'bin').mkdir()
        (target / 'bin/python').symlink_to(self.bundle / '.venv/bin/python')
        (target / 'pyvenv.cfg').write_text('fixture')

    def approved_archive(self, entries=None):
        value = self.derive()
        raw = archive(entries or [('chrome/chrome',b'not executable code',0o100755)])
        path = self.root / 'chromium-mac-arm64.zip'
        path.write_bytes(raw); path.chmod(0o600)
        candidate = {'url':value['chromium']['url'],'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'executable_relative_path':'chrome/chrome'}
        with patch.object(extras, '_approve', side_effect=self.approve):
            extras.approve_browser_archive(self.root,candidate)
        return path

    def test_install_coexist_no_overwrite_tamper(self):
        (self.root / 'extras-venv').mkdir(mode=0o700)
        with patch.object(extras, '_approve', side_effect=self.approve), patch.object(extras.venv.EnvBuilder,'create',side_effect=self.environment), patch.object(extras.subprocess,'run') as run:
            result = extras.install_browser(self.bundle,self.root)
            self.assertEqual(result['network'],'offline')
            self.assertIn('--no-index',run.call_args.args[0]); self.assertIn('--require-hashes',run.call_args.args[0])
            self.assertEqual(run.call_args.kwargs['env']['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'],'1')
            extras.browser_interpreter(self.bundle,self.root)
            with self.assertRaises(ValueError): extras.install_browser(self.bundle,self.root)
        (self.root / 'extras-browser-venv/lib/python3.12/site-packages/added').write_bytes(b'x')
        with self.assertRaises(ValueError): extras.browser_interpreter(self.bundle,self.root)

    def test_metadata_unknown_product_unchanged(self):
        before = (extras.HERE / 'extras-lock.json').read_bytes()
        result = self.derive()['chromium']
        self.assertEqual(result['revision'],'123'); self.assertIsNone(result['sha256'])
        self.assertEqual(result['wheel_sha256'],self.rows[0]['sha256'])
        self.assertEqual(before,(extras.HERE / 'extras-lock.json').read_bytes())
        with self.assertRaises(ValueError): self.derive()

    def test_metadata_revision_and_path_reject(self):
        row = self.rows[0]; path=self.staged / row['filename']
        raw = archive([('playwright/driver/package/browsers.json',b'{"browsers":[{"name":"chromium","revision":"1","browserVersion":"1.2.3.4","revisionOverrides":{"mac":"2"}}]}',0o100644),
                       ('playwright/driver/package/lib/server/registry/index.js',b'x',0o100644),
                       ('playwright/driver/package/lib/server/utils/hostPlatform.js',b'x',0o100644)])
        path.write_bytes(raw); row.update(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
        with self.assertRaisesRegex(ValueError,'revisionOverrides'): self.derive()
        self.assertTrue((self.root/'extras-lock.json').exists())
        with self.assertRaises(ValueError): self.derive()
        with zipfile.ZipFile(io.BytesIO(archive([('../evil',b'x',0o100644)]))) as z:
            with self.assertRaises(ValueError): extras._zip_entries(z)

    def test_cancel_exact_tty_hash_permission(self):
        value={'test':'exact'}
        digest=hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest()
        self.assertFalse(extras._approve(value,lambda _:digest+' '))
        self.assertTrue(extras._approve(value,lambda _:digest))
        with patch.object(sys.stderr,'isatty',return_value=False):
            with self.assertRaises(ValueError): extras._approve(value,lambda _:digest)
        with patch.object(extras,'_approve',return_value=False):
            self.assertEqual(extras.install_browser(self.bundle,self.root),{'cancelled':True})
        self.assertFalse((self.root/'extras-browser-venv').exists())
        path=self.staged/self.rows[0]['filename']; path.chmod(0o666)
        with self.assertRaises(ValueError): extras.validate_wheel(path,self.rows[0])
        path.chmod(0o600); path.write_bytes(b'tamper')
        with self.assertRaises(ValueError): extras.validate_wheel(path,self.rows[0])

    def test_archive_extract_tamper(self):
        path=self.approved_archive()
        with patch.object(extras,'_approve',side_effect=self.approve): extras.install_browser_archive(self.root,path)
        executable=extras.validate_browser_archive(self.root)
        self.assertEqual(executable.read_bytes(),b'not executable code')
        with self.assertRaises(ValueError): extras.install_browser_archive(self.root,path)
        executable.chmod(0o600)
        with self.assertRaises(ValueError): extras.validate_browser_archive(self.root)

    def test_archive_unsafe_keeps_incomplete(self):
        path=self.approved_archive([('chrome/chrome',b'linktarget',0o120777)])
        with patch.object(extras,'_approve',side_effect=self.approve):
            with self.assertRaises(ValueError): extras.install_browser_archive(self.root,path)
            self.assertTrue((self.root/'extras-browser').exists())
            with self.assertRaises(ValueError): extras.install_browser_archive(self.root,path)

    def test_pip_failure_keeps_incomplete_target(self):
        import subprocess
        with patch.object(extras, '_approve', side_effect=self.approve), patch.object(extras.venv.EnvBuilder, 'create', side_effect=self.environment), patch.object(extras.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'fixture')):
            with self.assertRaises(subprocess.CalledProcessError): extras.install_browser(self.bundle, self.root)
            self.assertTrue((self.root / 'extras-browser-venv').exists())
            self.assertFalse((self.root / 'extras-browser-venv/hub-ready.json').exists())
            with self.assertRaises(ValueError): extras.install_browser(self.bundle, self.root)

    def test_archive_approval_path_url_hash_and_cancel(self):
        value = self.derive()
        base = {'url': value['chromium']['url'], 'sha256': 'a'*64, 'bytes': 5, 'executable_relative_path': 'chrome/chrome'}
        for change in ({'url': 'https://wrong.invalid/a'}, {'sha256': 'bad'}, {'bytes': True}, {'executable_relative_path': '../escape'}):
            with self.subTest(change=change), self.assertRaises(ValueError): extras.approve_browser_archive(self.root, {**base, **change})
        with patch.object(extras, '_approve', return_value=False):
            self.assertEqual(extras.approve_browser_archive(self.root, base), {'cancelled': True})
        self.assertIsNone(json.loads((self.root / 'extras-lock.json').read_text())['chromium']['sha256'])

    def test_archive_hash_cancel_and_provenance(self):
        path = self.approved_archive()
        with patch.object(extras, '_approve', return_value=False):
            self.assertEqual(extras.install_browser_archive(self.root, path), {'cancelled': True})
        self.assertFalse((self.root / 'extras-browser').exists())
        raw = path.read_bytes(); path.write_bytes(b'x' * len(raw))
        with self.assertRaisesRegex(ValueError, 'wheel hash'): extras.install_browser_archive(self.root, path)
        path.write_bytes(raw)
        lock = self.root / 'extras-lock.json'; value = json.loads(lock.read_text())
        value['chromium']['revision'] = '999'; lock.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'metadata changed'): extras.install_browser_archive(self.root, path)

    def test_ambiguous_distribution_and_zip_bomb(self):
        row = self.rows[0]; wheel = self.staged / row['filename']
        with zipfile.ZipFile(wheel) as z:
            entries = [(i.filename, z.read(i), i.external_attr >> 16) for i in z.infolist()]
        entries = [(n, d.replace(b'builds/chromium/%s/', b'unknown/%s/') if n.endswith('index.js') else d, m) for n,d,m in entries]
        raw = archive(entries); wheel.write_bytes(raw)
        row.update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        with self.assertRaisesRegex(ValueError, 'template'): self.derive()
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as z: z.writestr('huge', b'0' * (2 * 1024 * 1024))
        with zipfile.ZipFile(io.BytesIO(out.getvalue())) as z:
            with self.assertRaisesRegex(ValueError, 'expansion'): extras._zip_entries(z)

    def test_zip_macos_names_and_count(self):
        for entries in ([('a', b'x', 0o100644), ('A', b'y', 0o100644)],
                        [('é', b'x', 0o100644), ('e\u0301', b'y', 0o100644)],
                        [('a\n', b'x', 0o100644)],
                        [('HUB-READY.JSON', b'x', 0o100755)],
                        [('a', b'x', 0o100644), ('A/b', b'x', 0o100644)]):
            with self.subTest(entries=entries), zipfile.ZipFile(io.BytesIO(archive(entries))) as z:
                with self.assertRaises(ValueError): extras._zip_entries(z)
        # zipfile's writer strips NUL; inject it into both archive name records.
        nul_zip = archive([('aXtail', b'x', 0o100644)]).replace(b'aXtail', b'a\x00tail')
        with zipfile.ZipFile(io.BytesIO(nul_zip)) as z:
            with self.assertRaisesRegex(ValueError, 'control'): extras._zip_entries(z)
        with patch.object(extras, 'MAX_ZIP_ENTRIES', 1), zipfile.ZipFile(io.BytesIO(archive([('a', b'x', 0o100644), ('b', b'x', 0o100644)]))) as z:
            with self.assertRaisesRegex(ValueError, 'count'): extras._zip_entries(z)

    def test_zip_rejections(self):
        for name,mode in [('hub-ready.json',0o100755),('a/../b',0o100644),('/absolute',0o100644),('a\\b',0o100644),('a',0o100666),('a',0o010644),('a',0o104755)]:
            with self.subTest(name=name,mode=mode), zipfile.ZipFile(io.BytesIO(archive([(name,b'x',mode)]))) as z:
                with self.assertRaises(ValueError): extras._zip_entries(z)
        with zipfile.ZipFile(io.BytesIO(archive([('a',b'123',0o100644)]))) as z:
            with self.assertRaises(ValueError): extras._zip_entries(z,limit=2)


if __name__=='__main__': unittest.main()

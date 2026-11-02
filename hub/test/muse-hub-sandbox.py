"""Mac OS boundaries against synthetic files only; no DNS or external service."""
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1] / 'lib/muse'
BUNDLE = HERE.parents[2] / '.ai/work/metamuse-local-20261024'


class Sandbox(unittest.TestCase):
    def test_offline_hash_manifest_read_allowlist(self):
        names = json.loads((HERE / 'tool-hashes.json').read_text())
        # Inspect only the file-read exception list, not process-exec permissions.
        profile = (HERE / 'offline.sb').read_text().split('(deny file-read-data', 1)[1]
        profile = profile.split('(deny file-write*', 1)[0]
        literals = set(re.findall(
            r'\(literal \(string-append \(param "bundle"\) "(/[^"]+)"\)\)', profile))
        missing = [name for name in names if not name.startswith('.venv/')
                   and '/' + name not in literals]
        self.assertEqual(missing, [], 'Hash verification must be readable inside offline.sb')

    def test_offline_hash_manifest_synthetic_read_boundary(self):
        names = json.loads((HERE / 'tool-hashes.json').read_text())
        # /Users is essential: offline.sb deliberately limits its read deny to it.
        # Everything created here is synthetic, inside this work copy, and removed
        # by TemporaryDirectory; the live private root and bundle are not used.
        with tempfile.TemporaryDirectory(prefix='muse-read-boundary-', dir=HERE.parents[2] / '.ai/work') as temporary:
            root = Path(temporary).resolve()
            self.assertIn('/Users/', str(root))
            bundle, bridge, private = (root / name for name in ('bundle', 'bridge', 'private'))
            for directory in (bundle, bridge, private):
                directory.mkdir(mode=0o700)
            allowed = []
            for name in names:
                target = bundle / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('synthetic:' + name)
                allowed.append(str(target))
            denied = [bundle / 'README.md', bundle / 'metamuse-hub.extra',
                      bundle / 'muse-register-core.py.extra', bundle / 'nested/metamuse-hub',
                      bridge / 'unlisted.py', root / 'outside.txt']
            for target in denied:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('synthetic:denied')
            probe = '''import json,pathlib,sys
allowed,denied=json.loads(sys.argv[1])
for name in allowed:
 data=pathlib.Path(name).read_text()
 assert data.startswith('synthetic:'), name
for name in denied:
 try: pathlib.Path(name).read_bytes()
 except PermissionError: pass
 else: raise AssertionError('unexpected read permission: '+name)
print(json.dumps({'read':len(allowed),'denied':len(denied)}))
'''
            result = subprocess.run(['/usr/bin/sandbox-exec', '-D', 'bundle=' + str(bundle),
                '-D', 'bridge=' + str(bridge), '-D', 'private=' + str(private),
                '-f', str(HERE / 'offline.sb'), str((BUNDLE / '.venv/bin/python').resolve()),
                '-I', '-B', '-c', probe, json.dumps([allowed, [str(p) for p in denied]])],
                capture_output=True, text=True, timeout=30,
                env={'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'read': len(names), 'denied': len(denied)})

    def test_profiles_and_local_cli(self):
        with tempfile.TemporaryDirectory(prefix='muse-hub-sandbox-', dir='/private/tmp') as temporary:
            root = Path(temporary)
            private = root / 'private'
            private.mkdir(mode=0o700)
            project = root / 'project'
            project.mkdir(mode=0o700)
            taskroot = private / 'projects/Synthetic/task'
            inputs = root / 'inputs'
            inputs.mkdir(mode=0o700)
            params = ['-D', 'bundle=' + str(BUNDLE), '-D', 'bridge=' + str(HERE),
                      '-D', 'private=' + str(private), '-D', 'taskroot=' + str(taskroot),
                      '-D', 'taskparent=' + str(taskroot.parent), '-D', 'project=' + str(project)]
            base = [str(BUNDLE / '.venv/bin/python'), '-I', '-B']
            env = {'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
            for profile in ('hub-offline.sb', 'hub-live.sb'):
                cmd = ['/usr/bin/sandbox-exec', *params, '-f', str(HERE / profile), *base]
                # No connection is attempted: port 80 must fail at the OS boundary.
                probe = '''import os,socket,json
results=[]
try:
 socket.socket().connect(('127.0.0.1',80))
 results.append(False)
except PermissionError: results.append(True)
except OSError: results.append(False)
for p in [os.environ['OUTSIDE_WRITE'], os.environ['LEGACY_WRITE']]:
 try:
  open(p,'w').write('no')
  results.append(False)
 except PermissionError: results.append(True)
try:
 open(os.environ['OUTSIDE_READ']).read()
 results.append(False)
except PermissionError: results.append(True)
print(json.dumps(results))
'''
                run = subprocess.run([*cmd, '-c', probe], env={**env, 'OUTSIDE_WRITE': str(root / 'denied'),
                    'LEGACY_WRITE': str(private / 'forbidden'), 'OUTSIDE_READ': str(BUNDLE / 'README.md')}, capture_output=True, text=True)
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(json.loads(run.stdout), [True] * 4, profile)
            # Actual production core with no binding: init, schemas, collect, history.
            core = [*cmd[:len(cmd)-len(base)], *base, str(HERE / 'hub_core.py'),
                    '--taskroot', str(taskroot), '--project-dir', str(project), '--inputs', str(inputs),
                    '--legacy', str(private), '--project', 'Synthetic', '--task', 'task']
            # Select offline explicitly (last loop used live).
            core[core.index(str(HERE / 'hub-live.sb'))] = str(HERE / 'hub-offline.sb')
            run = subprocess.run([*core, 'schemas'], env=env, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr + run.stdout)
            self.assertEqual(len(json.loads(run.stdout)['tools']), 19)
            request = project / 'collect.json'
            request.write_text(json.dumps({'inputs': [{'kind': 'text', 'text': 'Synthetic sandbox source'}],
                'resources': ['post'], 'limits': {'max_urls': 1, 'max_items': 2, 'max_bytes': 10000, 'wall_clock_seconds': 30},
                'access_grant_id': None, 'request_key': 'sandbox-import'}))
            run = subprocess.run([*core, '--run', 'metamuse_collect', str(request)], env=env, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr + run.stdout)
            self.assertEqual(json.loads(run.stdout)['data']['job']['state'], 'succeeded')
            self.assertEqual((taskroot / 'workspace/state.sqlite3').stat().st_mode & 0o777, 0o600)
            self.assertFalse((private / 'auth').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)

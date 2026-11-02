"""New credential intake OS boundary only; no previous tests repeated."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1] / 'lib/muse'
BUNDLE = HERE.parents[2] / '.ai/work/metamuse-local-20261024'

class Boundary(unittest.TestCase):
    def test_intake_read_and_human_network(self):
        with tempfile.TemporaryDirectory(prefix='muse-intake-os-', dir='/private/tmp') as temporary:
            root = Path(temporary)
            taskroot = root / 'private/projects/Synthetic/task'
            intake = taskroot / 'credential-intake'
            intake.mkdir(parents=True, mode=0o700)
            secret = intake / 'fixture.txt'
            secret.write_text('synthetic-only'); secret.chmod(0o600)
            params = ['-D', 'bundle=' + str(BUNDLE), '-D', 'bridge=' + str(HERE),
                '-D', 'private=' + str(root / 'private'), '-D', 'taskroot=' + str(taskroot),
                '-D', 'taskparent=' + str(taskroot.parent), '-D', 'project=' + str(root / 'project')]
            probe = '''import json,pathlib,socket,sys
try:
 pathlib.Path(sys.argv[1]).read_text()
 allowed=True
except PermissionError: allowed=False
network=None
if sys.argv[2]=='human':
 try: socket.socket().connect(('127.0.0.1',9)); network=False
 except PermissionError: network=True
 except OSError: network=False
print(json.dumps({'intakeReadable':allowed,'networkDenied':network}))
'''
            for profile in ('offline', 'live', 'human'):
                result = subprocess.run(['/usr/bin/sandbox-exec', *params, '-f', str(HERE / ('hub-' + profile + '.sb')),
                    str(BUNDLE / '.venv/bin/python'), '-I', '-B', '-c', probe, str(secret), profile],
                    capture_output=True, text=True, env={'PATH':'/usr/bin:/bin','LANG':'en_US.UTF-8'})
                self.assertEqual(result.returncode, 0, result.stderr)
                value = json.loads(result.stdout)
                self.assertEqual(value['intakeReadable'], profile == 'human')
                if profile == 'human': self.assertTrue(value['networkDenied'])

if __name__ == '__main__': unittest.main(verbosity=2)

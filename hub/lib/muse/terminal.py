#!/usr/bin/python3 -I
"""Offline, human-operated settings bridge. No cookie or root overrides in argv."""
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import logging
import os
from pathlib import Path
import pwd
import resource
import stat
import sys
import tempfile

HERE = Path(__file__).resolve().parent
OPERATIONS = ('status', 'register', 'update', 'disconnect')


def verify_bundle(bundle):
    expected = json.loads((HERE / 'tool-hashes.json').read_text())
    for name, digest in expected.items():
        path = bundle / name
        # Reject directory links, not just links at the leaf.
        current = Path('/')
        for part in path.parent.parts[1:]:
            current /= part
            if current.is_symlink() or not current.is_dir():
                raise ValueError('path')
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o022 or info.st_nlink != 1 or info.st_size > 2 * 1024 * 1024):
            raise ValueError('tool')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            with os.fdopen(fd, 'rb') as stream:
                if hashlib.sha256(stream.read()).hexdigest() != digest:
                    raise ValueError('version')
        except BaseException:
            raise


def registration(bundle):
    verify_bundle(bundle)
    spec = importlib.util.spec_from_file_location('muse_registration', bundle / 'muse-register-core.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def trial_state(root, core):
    trial = root / 'trial-v1'
    if not os.path.lexists(trial):
        return {'trialUsed': False, 'replyReceived': False, 'completionVerified': False, 'busy': False}
    core.directory(trial)
    attempt = trial / 'attempt.json'
    if not os.path.lexists(attempt):
        return {'trialUsed': False, 'replyReceived': False, 'completionVerified': False, 'busy': False}
    value = json.loads(core.safety._read_secret_file(attempt, 1024 * 1024))
    if (not isinstance(value, dict) or not isinstance(value.get('stage'), str)
            or not isinstance(value.get('replies', []), list)
            or any(not isinstance(x, str) for x in value.get('replies', []))):
        raise ValueError('invalid receipt')
    final = value.get('stage') in ('completed', 'reply_pending_no_retry', 'stopped_outcome_unconfirmed')
    real = value.get('mock') is False
    return {'trialUsed': True,
            'replyReceived': real and any(isinstance(x, str) and x.strip() for x in value.get('replies', [])),
            'completionVerified': real and value.get('stage') == 'completed' and value.get('connection_verified') is True,
            'busy': not final or value.get('revocation_unconfirmed') is True}


def status(root, core):
    value = core.status(root)  # Credential metadata only; never opens its contents.
    if value['configured']:
        ref = core.configuration(root).muse.binding.auth_ref
        if {p.name for p in (root / 'auth').iterdir()} != {ref + '.json'}:
            raise ValueError('extra credentials require manual review')
    if os.path.lexists(root) and not value['configured'] and os.path.lexists(root / 'auth'):
        core.directory(root / 'auth')
        if any((root / 'auth').iterdir()):
            raise ValueError('unbound credentials require manual review')
    return {'configured': value['configured'], **trial_state(root, core)}


@contextlib.contextmanager
def lock(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            raise ValueError('lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def change(root, core, operation):
    if operation not in ('register', 'update', 'disconnect') or not all(s.isatty() for s in (sys.stdin, sys.stdout, sys.stderr)):
        raise ValueError('human terminal required')
    # Acquire the same trial lock; refuse interrupted/uncertain remote operations.
    with contextlib.ExitStack() as stack:
        if os.path.lexists(root / 'trial-v1'):
            core.directory(root / 'trial-v1')
            stack.enter_context(lock(root / 'trial-v1/.lock'))
        if trial_state(root, core)['busy']:
            raise ValueError('trial busy')
        if operation == 'register':
            return core.register(root)  # Upstream human guard and existing non-echo input retained.
        core.directory(root)
        stack.enter_context(lock(root / '.registration.lock'))
        if not status(root, core)['configured']:
            raise ValueError('not configured')
        cfg = core.configuration(root)
        old_ref = cfg.muse.binding.auth_ref
        core.directory(root / 'tmp')
        if any((root / 'tmp').iterdir()):
            raise ValueError('uncertain input')
        print('通信なしの本人操作です。相談は送らず、過去の送信記録も残します。', flush=True)
        token = 'UPDATE' if operation == 'update' else 'DISCONNECT'
        print('更新では以前のログイン情報を置き換えます。解除ではこのMacの登録情報を削除します。Muse側のログアウトは行いません。', flush=True)
        if input('実行する場合だけ ' + token + ' と入力: ') != token:
            print('中止しました。登録情報は変更していません。', flush=True)
            return 2
        if operation == 'update':
            update(root, core, old_ref)
        else:
            disconnect(root, core, old_ref)
        print(json.dumps(status(root, core), ensure_ascii=False), flush=True)
        return 0


def update(root, core, old_ref):
    from metamuse._muse_adapters import parse_cookie_header
    secret = json.dumps({'format': 'cookie-header', 'cookie_header': core.read_cookie()}).encode()
    parse_cookie_header(secret)
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix='.settings-input-', dir=root / 'tmp')
        with os.fdopen(fd, 'wb') as stream:
            stream.write(secret)
            stream.flush()
            os.fsync(stream.fileno())
        secret = None
        if core.configuration(root).muse.binding.auth_ref != old_ref:
            raise ValueError('changed binding')
        ctx = core.app.AppContext.open(root / 'workspace-muse')
        ctx.secret_store = core.safety.SecretStore(root / 'auth')
        result = core.connect_account(ctx, core.ConnectRequest(service='muse', account=core.ACCOUNT,
                                      auth_file=temporary, enable_network=False))
        if result.status != 'ok' or result.data.get('network_mode') != 'offline' or result.data.get('account_verified') is not False:
            raise ValueError('not confirmed')
        # The upstream atomic config replacement succeeded; only now remove the old record.
        ctx.secret_store.revoke(old_ref)
    finally:
        secret = None
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)


def disconnect(root, core, old_ref):
    import tomlkit
    from metamuse.config import Config
    from metamuse.store import file_lock
    import tomllib
    path = root / 'workspace-muse/metamuse.toml'
    # Same config lock as upstream connect; don't race a separate human CLI.
    runtime = root / 'workspace-muse/runtime'
    core.directory(runtime)
    with file_lock(runtime / 'connect.lock', blocking=False):
        original = core.safety._read_secret_file(path, core.safety.SECRET_MAX_BYTES)
        doc = tomlkit.parse(original.decode())
        if doc['muse']['binding']['auth_ref'] != old_ref:
            raise ValueError('changed binding')
        doc['muse']['enabled'] = False
        del doc['muse']['binding']
        doc['app']['network_mode'] = 'offline'
        Config.model_validate(tomllib.loads(tomlkit.dumps(doc)))
        temporary = None
        try:
            fd, temporary = tempfile.mkstemp(prefix='.settings-disconnect-', dir=path.parent)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(tomlkit.dumps(doc).encode())
                stream.flush()
                os.fsync(stream.fileno())
            if core.safety._read_secret_file(path, core.safety.SECRET_MAX_BYTES) != original:
                raise ValueError('changed config')
            os.replace(temporary, path)
            temporary = None
            core.safety.SecretStore(root / 'auth').revoke(old_ref)
        finally:
            if temporary is not None:
                Path(temporary).unlink(missing_ok=True)


def main():
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    logging.disable(logging.CRITICAL)
    args = sys.argv[1:]
    if len(args) == 4 and args[1] == 'workspace':
        # A separate entry keeps the reviewed registration/trial behavior intact.
        os.execv('/usr/bin/python3', ['/usr/bin/python3', '-I', str(HERE / 'hub_launcher.py'),
                  '--bundle', args[0], '--project', args[2], '--task', args[3], 'menu'])
    inner = len(args) == 3 and args[0] == '--inner'
    args = args[1:] if inner else args
    if len(args) != 2 or args[1] not in OPERATIONS or sys.platform != 'darwin':
        raise ValueError('arguments')
    bundle, operation = Path(args[0]), args[1]
    root = Path(pwd.getpwuid(os.getuid()).pw_dir) / 'Library/Application Support/metamuse-hub-20260926-hub-v2'
    if not inner:
        verify_bundle(bundle)
        os.chdir('/')
        os.execve('/usr/bin/sandbox-exec', ['/usr/bin/sandbox-exec', '-D', 'bundle=' + str(bundle),
                  '-D', 'bridge=' + str(HERE), '-D', 'private=' + str(root), '-f', str(HERE / 'offline.sb'),
                  str(bundle / '.venv/bin/python'), '-I', '-B', str(HERE / 'terminal.py'), '--inner', str(bundle), operation],
                  {'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8', 'TMPDIR': str(root / 'tmp'),
                   'PYTHONDONTWRITEBYTECODE': '1', 'OTEL_SDK_DISABLED': 'true', 'DO_NOT_TRACK': '1', 'NO_COLOR': '1'})
    core = registration(bundle)
    if operation == 'status':
        print(json.dumps(status(root, core), ensure_ascii=False))
        return 0
    return change(root, core, operation)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('中断しました。自動再試行しません。状態を確認してください。', file=sys.stderr)
        sys.exit(130)
    except Exception:
        print('操作を完了できませんでした。秘密は表示しません。再登録せず、設定の状態を確認してください。', file=sys.stderr)
        sys.exit(1)

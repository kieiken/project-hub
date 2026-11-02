"""Verified task-scoped Mac executable adapter; upstream source stays immutable."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import stat

HERE = Path(__file__).resolve().parent
BLOCKERS = ['Browser packages, approved Chromium archive and task adapter must all pass verification before Facebook collection.']


def _extras():
    spec = importlib.util.spec_from_file_location('fb_runtime_extras', HERE / 'extras.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def is_facebook_collection(tool, request):
    if tool != 'metamuse_collect':
        return False
    from metamuse import facebook, models
    return facebook.is_facebook_post_request(models.CollectRequest.model_validate(request))


def _layout(taskroot, extra):
    root = Path(taskroot)
    row = extra._local_lock(root)['chromium']
    revision = row['revision']
    if not isinstance(revision, str) or not re.fullmatch('[0-9]+', revision):
        raise ValueError('invalid derived browser revision')
    executable = extra.validate_browser_archive(root)
    extra.checked(executable)
    if not executable.stat().st_mode & stat.S_IXUSR:
        raise ValueError('browser executable permission')
    cache = root / 'facebook-browser-cache'
    wrapper = cache / ('chromium-' + revision) / 'chrome-linux64/chrome'
    # No shell interpolation of paths or arguments. No credential/proxy inheritance.
    args = ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=en_US.UTF-8',
            'HOME=' + str(root / 'browser-home'), 'TMPDIR=' + str(root / 'browser-tmp'), str(executable)]
    script = '#!/bin/sh\nexec ' + ' '.join(shlex.quote(x) for x in args) + ' "$@"\n'
    return row, executable, cache, wrapper, script


def install_adapter(taskroot):
    extra = _extras()
    core = extra._core()
    row, executable, cache, wrapper, script = _layout(taskroot, extra)
    extra._fresh(cache)
    core.private_dir(wrapper.parent)
    for name in ('browser-home', 'browser-tmp'):
        core.private_dir(Path(taskroot) / name)
    core.save(wrapper, script)
    wrapper.chmod(0o700)
    receipt = {'archive': row, 'executable_sha256': hashlib.sha256(executable.read_bytes()).hexdigest(),
               'wrapper_sha256': hashlib.sha256(script.encode()).hexdigest(), 'tree': extra._tree(cache)}
    core.save(cache / 'hub-ready.json', json.dumps(receipt, sort_keys=True))
    return cache


def _verify_supported_runtime(taskroot=None, bundle=None):
    if taskroot is None or bundle is None:
        raise ValueError('Facebook browser collection on this Mac is blocked: verified task runtime required')
    extra = _extras()
    extra.browser_interpreter(bundle, taskroot)
    row, executable, cache, wrapper, script = _layout(taskroot, extra)
    if cache.is_symlink() or stat.S_IMODE(cache.stat().st_mode) != 0o700:
        raise ValueError('unsafe browser adapter root')
    value = json.loads(extra.checked(cache / 'hub-ready.json').read_text())
    if (value.get('archive') != row or value.get('tree') != extra._tree(cache)
            or value.get('executable_sha256') != hashlib.sha256(executable.read_bytes()).hexdigest()
            or value.get('wrapper_sha256') != hashlib.sha256(script.encode()).hexdigest()
            or extra.checked(wrapper).read_text() != script or stat.S_IMODE(wrapper.stat().st_mode) != 0o700):
        raise ValueError('browser adapter changed')
    for name in ('browser-home', 'browser-tmp'):
        directory = Path(taskroot) / name
        if directory.is_symlink() or not directory.is_dir() or directory.stat().st_uid != os.getuid() or stat.S_IMODE(directory.stat().st_mode) != 0o700:
            raise ValueError('unsafe browser runtime directory')
    return cache


def require_supported_runtime(taskroot=None, bundle=None):
    try:
        return _verify_supported_runtime(taskroot, bundle)
    except (OSError, KeyError, TypeError, ValueError) as error:
        raise ValueError('Facebook browser collection on this Mac is blocked: task runtime verification failed') from error


def profile_name(mode, operation, facebook=False, taskroot=None, bundle=None):
    if mode == 'live':
        if operation == 'metamuse_collect' and facebook:
            require_supported_runtime(taskroot, bundle)
            return 'hub-fb-live.sb'
        return 'hub-live.sb'
    return 'hub-human.sb' if operation == 'menu' else 'hub-offline.sb'

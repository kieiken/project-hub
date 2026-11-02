"""Offline extras staging. Never downloads or changes the fixed base environment."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import venv

HERE = Path(__file__).resolve().parent


def checked(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('absolute normalized extras path required')
    current = Path('/')
    for part in path.parts[1:]:
        current /= part
        if current.is_symlink():
            raise ValueError('linked extras file')
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('unsafe extras file')
    return path


def manifest():
    return json.loads((HERE / 'extras-lock.json').read_text())


def validate_wheel(path, row):
    path = checked(path)
    if path.name != row['filename'] or path.stat().st_size != row['bytes']:
        raise ValueError('wheel size/name')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            digest.update(chunk)
    if digest.hexdigest() != row['sha256']:
        raise ValueError('wheel hash')
    return path


def validate_runtime(bundle, target):
    if target.is_symlink() or target.stat().st_uid != os.getuid() or stat.S_IMODE(target.stat().st_mode) != 0o700:
        raise ValueError('unsafe extras environment')
    for directory in (target, target / 'bin'):
        if directory.is_symlink() or not directory.is_dir() or directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o022:
            raise ValueError('unsafe extras runtime directory')
    checked(target / 'pyvenv.cfg')
    executable = target / 'bin/python'
    if executable.resolve(strict=True) != (Path(bundle) / '.venv/bin/python').resolve(strict=True):
        raise ValueError('extras interpreter is not the fixed Python')
    return executable


def _pip_environment(taskroot, name):
    root = _core().checked(Path(taskroot), True)
    temporary = root / name
    # Exclusive creation: never reuse or remove an earlier attempt's files.
    temporary.mkdir(mode=0o700)
    env = {k: v for k, v in os.environ.items() if not k.startswith('PIP_')}
    env.update(TMPDIR=str(temporary), PIP_NO_CACHE_DIR='1', PIP_NO_INDEX='1',
               PIP_CONFIG_FILE=os.devnull)
    return temporary, env


def install_video(bundle, taskroot, reader=input):
    import importlib.util
    spec = importlib.util.spec_from_file_location('extras_bridge_utils', HERE / 'hub_core.py')
    core = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(core)
    private_dir, save = core.private_dir, core.save
    if not all(s.isatty() for s in (sys.stdin, sys.stdout, sys.stderr)):
        raise ValueError('human terminal required')
    lock = manifest()
    row = next(x for x in lock['wheels'] if x['name'] == 'yt-dlp')
    staged = Path(taskroot) / 'extras-wheels'
    private_dir(staged)
    wheel = validate_wheel(staged / row['filename'], row)
    target = Path(taskroot) / 'extras-venv'
    if os.path.lexists(target):
        raise ValueError('existing or incomplete extras environment; no overwrite')
    print(json.dumps({'offline_install': row, 'notice': '取得済みの検証済みファイルだけを別環境へ導入します。通信・認証変更・相談送信はしません。'}, ensure_ascii=False))
    digest = hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest()
    print('確認番号: ' + digest)
    if reader('本人が了承する場合は確認番号全文: ') != digest:
        return {'cancelled': True}
    temporary, env = _pip_environment(taskroot, 'extras-venv-pip-tmp')
    save(staged / 'verified-requirements.txt', wheel.as_uri() + ' --hash=sha256:' + row['sha256'] + '\n')
    venv.EnvBuilder(with_pip=True, symlinks=True).create(target)
    target.chmod(0o700)
    validate_runtime(bundle, target)
    subprocess.run([str(target / 'bin/python'), '-I', '-m', 'pip', '--disable-pip-version-check',
                    'install', '--no-index', '--no-deps', '--no-compile', '--require-hashes', '-r', str(staged / 'verified-requirements.txt')],
                   check=True, capture_output=True, env=env)
    site = target / 'lib/python3.12/site-packages'
    # Own extras first, immutable pinned MetaMuse/dependencies second; no global site.
    base = Path(bundle) / '.venv/lib/python3.12/site-packages'
    save(site / 'metamuse-fixed-base.pth', str(base) + '\n')
    files = {str(p.relative_to(target)): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in site.rglob('*') if p.is_file()}
    save(target / 'hub-ready.json', json.dumps({'lock_sha256': hashlib.sha256((HERE / 'extras-lock.json').read_bytes()).hexdigest(),
        'features': ['remote-media'], 'files': files}, sort_keys=True))
    shutil.rmtree(temporary)
    return {'installed': ['yt-dlp==2026.8.19'], 'facebook': 'blocked pending verified Chromium metadata and compatible browser support', 'network': 'offline'}


def interpreter(bundle, taskroot):
    """Only a fully recorded isolated environment may replace the base interpreter."""
    target = Path(taskroot) / 'extras-venv'
    receipt = target / 'hub-ready.json'
    if not os.path.lexists(target):
        return Path(bundle) / '.venv/bin/python'
    validate_runtime(bundle, target)
    checked(receipt)
    value = json.loads(receipt.read_text())
    if value.get('lock_sha256') != hashlib.sha256((HERE / 'extras-lock.json').read_bytes()).hexdigest() or value.get('features') != ['remote-media']:
        raise ValueError('extras lock mismatch')
    actual = set()
    for path in (target / 'lib/python3.12/site-packages').rglob('*'):
        if path.is_file():
            checked(path)
            rel = str(path.relative_to(target))
            actual.add(rel)
            if hashlib.sha256(path.read_bytes()).hexdigest() != value['files'].get(rel):
                raise ValueError('extras changed')
    if actual != set(value['files']):
        raise ValueError('extras tree changed')
    return target / 'bin/python'

# Browser extras use a separate environment and never invoke Playwright's installer.
import re
import zipfile
import unicodedata
from urllib.parse import urlsplit

BROWSER_NAMES = ('playwright', 'greenlet', 'pyee', 'typing-extensions')
MAX_ARCHIVE_BYTES = 2 * 1024 ** 3
MAX_EXPANDED_BYTES = 4 * 1024 ** 3
MAX_ZIP_ENTRIES = 20000


def _core():
    import importlib.util
    spec = importlib.util.spec_from_file_location('extras_browser_utils', HERE / 'hub_core.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _approve(value, reader):
    if not all(s.isatty() for s in (sys.stdin, sys.stdout, sys.stderr)):
        raise ValueError('human terminal required')
    print(json.dumps(value, sort_keys=True, ensure_ascii=False))
    digest = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
    print('確認番号: ' + digest)
    return reader('本人が了承する場合は確認番号全文: ') == digest


def _fresh(path):
    if os.path.lexists(path):
        raise ValueError('existing or incomplete extras target; no overwrite')


def preserve_incomplete_video(bundle, taskroot, reader=input):
    """Owner-only quarantine; never execute, repair or delete the partial venv."""
    import uuid
    core = _core()
    root = core.checked(Path(taskroot), True)
    target = root / 'extras-venv'
    fixed = Path(bundle) / '.venv/bin/python'

    def snapshot():
        core.checked(target, True)
        if stat.S_IMODE(target.stat().st_mode) != 0o700:
            raise ValueError('unsafe incomplete environment')
        if os.path.lexists(target / 'hub-ready.json'):
            raise ValueError('recorded extras environment; no recovery')
        checked(target / 'pyvenv.cfg')
        core.checked(target / 'bin', True)
        executable = target / 'bin/python'
        if executable.is_symlink():
            validate_runtime(bundle, target)
        elif hashlib.sha256(checked(executable).read_bytes()).digest() != hashlib.sha256(fixed.read_bytes()).digest():
            raise ValueError('incomplete interpreter differs from fixed Python')
        return {'inode': target.stat().st_ino, 'tree': _tree(target, fixed)}

    before = snapshot()
    # Reserve a new private container only AFTER approval. Its child cannot
    # already exist; never rename onto a pre-existing backup or overwrite data.
    container = root / ('extras-venv-incomplete-' + uuid.uuid4().hex)
    destination = container / target.name
    approval = {'preserve_incomplete_video': str(target), 'destination': str(destination),
                'snapshot_sha256': hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(),
                'entries': len(before['tree']), 'network': 'offline', 'install': False,
                'notice': '未完了の動画用環境を別名の保管先へ移します。中身は変更・削除せず、再導入もしません。'}
    if not _approve(approval, reader):
        return {'cancelled': True}
    if snapshot() != before:
        raise ValueError('incomplete environment changed after approval')
    container.mkdir(mode=0o700)
    target.rename(destination)
    if _tree(destination, fixed) != before['tree']:
        raise ValueError('preserved environment changed; inspect backup, no automatic retry')
    core.save(container / 'preservation.json', json.dumps({**approval, 'snapshot': before}, sort_keys=True))
    return {'preserved': str(destination), 'network': 'offline', 'installed': False,
            'next': '保管結果を確認後、本人メニュー10で新しい環境への導入を別途承認してください。'}


def _tree(root, allow_python=None, *, browser_links=False):
    """Receipt includes directories, modes and every file; reject links/specials."""
    result = {}
    for path in sorted(root.rglob('*')):
        rel = str(path.relative_to(root))
        info = path.lstat()
        mode = stat.S_IMODE(info.st_mode)
        if info.st_uid != os.getuid() or (not stat.S_ISLNK(info.st_mode) and mode & 0o022):
            raise ValueError('unsafe extras tree permissions')
        if stat.S_ISLNK(info.st_mode):
            if allow_python and path.parent == root / 'bin' and path.name in ('python', 'python3', 'python3.12') and path.resolve(strict=True) == allow_python.resolve(strict=True):
                result[rel] = {'link': os.readlink(path), 'mode': mode}
                continue
            if browser_links:
                _safe_browser_link(rel, os.readlink(path))
                resolved = path.resolve(strict=True)
                bundle = root / _app_bundle(rel)
                if not resolved.is_relative_to(bundle) or not resolved.is_relative_to(root):
                    raise ValueError('browser link escaped app bundle')
                result[rel] = {'link': os.readlink(path), 'mode': mode}
                continue
            raise ValueError('linked extras tree')
        if stat.S_ISDIR(info.st_mode):
            result[rel] = {'directory': True, 'mode': mode}
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            if rel != 'hub-ready.json':
                result[rel] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'mode': mode}
        else:
            raise ValueError('unsafe extras tree entry')
    return result


def _local_lock(taskroot):
    path = Path(taskroot) / 'extras-lock.json'
    checked(path)
    value = json.loads(path.read_text())
    if value.get('product_lock_sha256') != hashlib.sha256((HERE / 'extras-lock.json').read_bytes()).hexdigest():
        raise ValueError('task extras lock provenance mismatch')
    row = next(x for x in manifest()['wheels'] if x['name'] == 'playwright')
    wheel = validate_wheel(Path(taskroot) / 'extras-wheels' / row['filename'], row)
    derived = _metadata(wheel, row)
    actual = value.get('chromium', {})
    for key in ('version', 'revision', 'platform', 'url', 'wheel_sha256', 'wheel_source', 'sources', 'host_platforms'):
        if actual.get(key) != derived.get(key):
            raise ValueError('task browser metadata changed')
    if derived['executable_relative_path'] is not None and actual.get('executable_relative_path') != derived['executable_relative_path']:
        raise ValueError('task browser executable changed')
    return value


def _app_bundle(name):
    parts = name.split('/')
    apps = [i for i, part in enumerate(parts) if part.endswith('.app')]
    if not apps:
        raise ValueError('browser link requires an app bundle')
    return '/'.join(parts[:apps[-1] + 1])


def _safe_browser_link(name, link):
    """Lexically resolve relative links, never leaving their original .app."""
    bundle = _app_bundle(name).split('/')
    if (not link or len(link.encode()) > 4096 or link.startswith('/') or '\\' in link
            or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in link)):
        raise ValueError('unsafe browser link target')
    parts = name.split('/')[:-1]
    for part in link.split('/'):
        if part == '..':
            if len(parts) <= len(bundle):
                raise ValueError('browser link escaped app bundle')
            parts.pop()
        elif part not in ('', '.'):
            if ':' in part or part.endswith(('.', ' ')):
                raise ValueError('ambiguous browser link target')
            parts.append(part)
    if parts[:len(bundle)] != bundle:
        raise ValueError('browser link escaped app bundle')
    return '/'.join(parts)


def _browser_zip_links(zf, entries):
    links = {}
    names = {item.filename.rstrip('/') for item in entries}
    for name in list(names):
        names.update('/'.join(name.split('/')[:i]) for i in range(1, len(name.split('/'))))
    for item in entries:
        if stat.S_IFMT(item.external_attr >> 16) == stat.S_IFLNK:
            if item.is_dir() or item.file_size > 4096:
                raise ValueError('invalid browser link')
            links[item.filename] = zf.read(item).decode('utf-8', errors='strict')
            _safe_browser_link(item.filename, links[item.filename])
    # Resolve every prefix so directory links and cycles cannot escape or dangle.
    for name, link in links.items():
        destination = _safe_browser_link(name, link)
        visited = {name}
        for _ in range(len(links) + 1):
            parts = destination.split('/')
            found = next(('/'.join(parts[:i]) for i in range(1, len(parts) + 1)
                          if '/'.join(parts[:i]) in links), None)
            if found is None:
                if destination not in names:
                    raise ValueError('dangling browser link')
                break
            if found in visited:
                raise ValueError('cyclic browser link')
            visited.add(found)
            suffix = destination[len(found):]
            destination = _safe_browser_link(found, links[found]) + suffix
            if _app_bundle(destination) != _app_bundle(name):
                raise ValueError('browser link chain escaped bundle')
        else:
            raise ValueError('browser link chain limit')
    return links


def _zip_entries(zf, limit=MAX_EXPANDED_BYTES, *, metadata_only=False, browser_links=False):
    """Inspect every entry. Read-only metadata may have group-writable regulars.

    This exception never applies to extraction, directories, links or specials.
    """
    seen = set()
    canonical = {}
    implied_directories = set()
    total = 0
    entries = zf.infolist()
    if len(entries) > MAX_ZIP_ENTRIES:
        raise ValueError('zip entry count limit')
    for item in entries:
        name = item.filename
        if item.orig_filename != name or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in name):
            raise ValueError('zip control filename')
        parts = name.rstrip('/').split('/')
        if name.rstrip('/') in ('hub-ready.json', 'hub-ready.json.new') or not name or name.startswith('/') or '\\' in name or any(p in ('', '.', '..') or ':' in p for p in parts):
            raise ValueError('unsafe zip path')
        normalized = '/'.join(unicodedata.normalize('NFC', p).casefold() for p in parts)
        if normalized in ('hub-ready.json', 'hub-ready.json.new'):
            raise ValueError('zip reserved receipt filename')
        if normalized in canonical:
            raise ValueError('zip normalized filename collision')
        if any(p.endswith(('.', ' ')) for p in parts):
            raise ValueError('zip ambiguous filename')
        ancestors = ['/'.join(normalized.split('/')[:i]) for i in range(1, len(parts))]
        for ancestor in ancestors:
            if canonical.get(ancestor) == 'file':
                raise ValueError('zip file/directory collision')
        if not item.is_dir() and normalized in implied_directories:
            raise ValueError('zip file/directory collision')
        implied_directories.update(ancestors)
        canonical[normalized] = 'directory' if item.is_dir() else 'file'
        if name.rstrip('/') in seen or item.flag_bits & 1:
            raise ValueError('duplicate or encrypted zip entry')
        seen.add(name.rstrip('/'))
        extra = item.extra
        while extra:
            if len(extra) < 4:
                raise ValueError('malformed zip extra')
            tag, length = int.from_bytes(extra[:2], 'little'), int.from_bytes(extra[2:4], 'little')
            if tag in (0x000d, 0x756e) or length > len(extra) - 4:
                raise ValueError('zip Unix link metadata or malformed extra')
            extra = extra[4 + length:]
        mode = item.external_attr >> 16
        kind = stat.S_IFMT(mode)
        forbidden = 0o7022
        if metadata_only and kind == stat.S_IFREG and not item.is_dir():
            forbidden &= ~0o020
        link = browser_links and not metadata_only and kind == stat.S_IFLNK
        if ((kind not in (0, stat.S_IFREG, stat.S_IFDIR) and not link)
                or (mode & forbidden and not link) or (link and mode & 0o7000)):
            raise ValueError('zip link/special/unsafe permissions')
        if item.is_dir() != (kind == stat.S_IFDIR) and kind != 0:
            raise ValueError('zip type mismatch')
        total += item.file_size
        if item.file_size > limit or total > limit or (item.file_size > 1024 * 1024 and item.file_size > max(1, item.compress_size) * 200):
            raise ValueError('zip expansion limit')
    if browser_links:
        _browser_zip_links(zf, entries)
    return entries


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate metadata key')
        result[key] = value
    return result


def _one(pattern, source, label):
    matches = re.findall(pattern, source, re.MULTILINE | re.DOTALL)
    if len(matches) != 1:
        raise ValueError('unknown or ambiguous ' + label)
    return matches[0]


def _chromium_table(bundle, name):
    # Recognize only the pinned bundle's literal table format, not arbitrary JS.
    if len(re.findall(r'\b' + name + r'\s*=', bundle)) != 1:
        raise ValueError('ambiguous ' + name)
    table = _one(r'^    ' + name + r' = \{\n(.*?)^    \};$', bundle, name)
    blocks = list(re.finditer(r'^      "([^"\n]+)": \{\n(.*?)^      \},?\n', table, re.MULTILINE | re.DOTALL))
    if ''.join(m.group(0) for m in blocks) != table:
        raise ValueError('unknown table layout: ' + name)
    groups = _unique_pairs((m.group(1), m.group(2)) for m in blocks)
    if 'chromium' not in groups:
        raise ValueError('missing Chromium table')
    rows = []
    for line in groups['chromium'].splitlines():
        match = re.fullmatch(r'        "([^"\n]+)": (.+?)(?:,)?', line)
        if not match:
            raise ValueError('unknown Chromium table row')
        rows.append(match.groups())
    return _unique_pairs(rows)


def _cft_metadata(bundle, version):
    helper = _one(r'^function cftUrl\(suffix\) \{\n.*?^\}', bundle, 'CfT helper')
    expected = '''function cftUrl(suffix) {
  return ({ browserVersion }) => {
    return {
      path: `builds/cft/${browserVersion}/${suffix}`,
      mirrors: [
        "https://cdn.playwright.dev"
      ]
    };
  };
}'''
    if helper != expected or len(re.findall(r'\bfunction cftUrl\b', bundle)) != 1:
        raise ValueError('unknown CfT URL function')
    downloads = _chromium_table(bundle, 'DOWNLOAD_PATHS')
    hosts = []
    suffixes = set()
    for host, value in downloads.items():
        if re.fullmatch(r'mac[0-9]+-arm64', host) and value != 'void 0':
            suffix = re.fullmatch(r'cftUrl\("(mac-arm64/chrome-mac-arm64\.zip)"\)', value)
            if not suffix:
                raise ValueError('unknown Chromium CfT distribution mapping')
            hosts.append(host)
            suffixes.add(suffix[1])
    if not hosts or len(suffixes) != 1:
        raise ValueError('ambiguous Chromium CfT distribution mapping')
    executables = _chromium_table(bundle, 'EXECUTABLE_PATHS')
    parts = json.loads(executables.get('mac-arm64', 'null'))
    if parts != ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing']:
        raise ValueError('unknown Chromium executable mapping')
    # The host mapping is source evidence only. Never inspect the host or honor
    # Playwright environment overrides, and never run this bundle.
    platform = _one(r'^function calculatePlatform\(\) \{\n.*?^\}', bundle, 'host platform function')
    if '''    let macPlatform = "mac" + macVersion;
    if (macVersion >= 11 && import_os3.default.cpus().some((cpu) => cpu.model.includes("Apple"))) {
      macPlatform += "-arm64";
    }
    return { hostPlatform: macPlatform, isOfficiallySupportedPlatform: macVersion >= 14 };''' not in platform:
        raise ValueError('unknown mac-arm64 host mapping')
    return {'url': 'https://cdn.playwright.dev/builds/cft/' + version + '/' + suffixes.pop(),
            'executable_relative_path': '/'.join(parts), 'host_platforms': sorted(hosts)}


def _legacy_metadata(source, revision):
    # Require an explicit mac-arm64 mapping, a single template, and a fixed CDN.
    registry = source['registry']
    templates = set(re.findall(r'''["']mac(?:[0-9]+)?-arm64["']\s*:\s*["']([^"']+)["']''', registry))
    templates = {x for x in templates if 'chromium-mac-arm64.zip' in x}
    if len(templates) != 1:
        raise ValueError('ambiguous mac-arm64 distribution mapping')
    template = templates.pop()
    if template != 'builds/chromium/%s/chromium-mac-arm64.zip':
        raise ValueError('unknown Chromium distribution template')
    cdns = set(re.findall(r'https://[A-Za-z0-9./_-]+', registry))
    if 'https://cdn.playwright.dev/dbazure/download/playwright' not in cdns:
        raise ValueError('unknown Chromium CDN source')
    if 'arm64' not in source['platform'] or not re.search(r'mac(?:[0-9]+)?-', source['platform']):
        raise ValueError('unknown mac-arm64 host mapping')
    return {'url': 'https://cdn.playwright.dev/dbazure/download/playwright/' + template.replace('%s', revision),
            'executable_relative_path': None}


def _metadata(wheel, row):
    """Read verified wheel as data only; unknown or mixed layouts fail closed."""
    prefix = 'playwright/driver/package/'
    legacy = {'registry': prefix + 'lib/server/registry/index.js',
              'platform': prefix + 'lib/server/utils/hostPlatform.js'}
    bundled = {'bundle': prefix + 'lib/coreBundle.js'}
    with zipfile.ZipFile(wheel) as zf:
        _zip_entries(zf, metadata_only=True)
        names = set(zf.namelist())
        if bundled['bundle'] in names:
            if any(p in names for p in legacy.values()):
                raise ValueError('ambiguous browser source layout')
            paths = {'browsers': prefix + 'browsers.json', **bundled}
        elif all(p in names for p in legacy.values()):
            paths = {'browsers': prefix + 'browsers.json', **legacy}
        else:
            raise ValueError('unknown browser source layout')
        source = {}
        for key, name in paths.items():
            if name not in names:
                raise ValueError('missing browser metadata source')
            info = zf.getinfo(name)
            if info.is_dir() or info.file_size > 4 * 1024 * 1024:
                raise ValueError('oversize or non-file browser metadata')
            source[key] = zf.read(name).decode('utf-8')
    data = json.loads(source['browsers'], object_pairs_hook=_unique_pairs)
    if not isinstance(data, dict) or not isinstance(data.get('browsers'), list) or any(not isinstance(x, dict) for x in data['browsers']):
        raise ValueError('unknown browsers manifest')
    matches = [x for x in data['browsers'] if x.get('name') == 'chromium']
    if len(matches) != 1:
        raise ValueError('ambiguous Chromium metadata')
    browser = matches[0]
    if browser.get('revisionOverrides'):
        raise ValueError('revisionOverrides require review')
    revision, version = browser.get('revision'), browser.get('browserVersion')
    if not isinstance(revision, str) or not re.fullmatch(r'[0-9]+', revision) or not isinstance(version, str) or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){3}', version):
        raise ValueError('unknown Chromium revision/version')
    distribution = _cft_metadata(source['bundle'], version) if 'bundle' in source else _legacy_metadata(source, revision)
    return {'version': version, 'revision': revision, 'platform': 'mac-arm64',
            **distribution, 'sha256': None, 'bytes': None,
            'status': 'derived from verified wheel; archive approval required',
            'wheel_sha256': row['sha256'], 'wheel_source': row.get('url'),
            'sources': {paths[k]: hashlib.sha256(v.encode()).hexdigest() for k, v in source.items()}}


def derive_browser_metadata(taskroot, reader=input):
    core = _core()
    root = Path(taskroot)
    core.private_dir(root)
    destination = root / 'extras-lock.json'
    _fresh(destination)
    row = next(x for x in manifest()['wheels'] if x['name'] == 'playwright')
    wheel = validate_wheel(root / 'extras-wheels' / row['filename'], row)
    if not _approve({'derive_browser_metadata': row, 'network': 'offline'}, reader):
        return {'cancelled': True}
    # Reserve the target before parsing; failed attempts cannot silently retry.
    core.save(destination, json.dumps({'status': 'incomplete metadata inspection'}))
    derived = _metadata(wheel, row)
    value = {'schema': 1, 'product_lock_sha256': hashlib.sha256((HERE / 'extras-lock.json').read_bytes()).hexdigest(), 'chromium': derived}
    core.save(destination, json.dumps(value, sort_keys=True))
    return value


def install_browser(bundle, taskroot, reader=input):
    core = _core()
    root = Path(taskroot)
    core.private_dir(root)
    staged = root / 'extras-wheels'
    core.private_dir(staged)
    rows = [next(x for x in manifest()['wheels'] if x['name'] == name) for name in BROWSER_NAMES]
    wheels = [validate_wheel(staged / row['filename'], row) for row in rows]
    target = root / 'extras-browser-venv'
    _fresh(target)
    if not _approve({'offline_browser_install': rows, 'network': 'offline', 'browser_execution': False}, reader):
        return {'cancelled': True}
    temporary, env = _pip_environment(root, 'extras-browser-venv-pip-tmp')
    env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'] = '1'
    target.mkdir(mode=0o700)
    requirements = target / 'verified-requirements.txt'
    core.save(requirements, ''.join(p.as_uri() + ' --hash=sha256:' + r['sha256'] + '\n' for p, r in zip(wheels, rows)))
    venv.EnvBuilder(with_pip=True, symlinks=True).create(target)
    target.chmod(0o700)
    validate_runtime(bundle, target)
    subprocess.run([str(target / 'bin/python'), '-I', '-B', '-m', 'pip', '--disable-pip-version-check', 'install', '--no-index', '--no-deps', '--no-compile', '--require-hashes', '-r', str(requirements)], check=True, capture_output=True,
                   env=env)
    core.save(target / 'lib/python3.12/site-packages/metamuse-fixed-base.pth', str(Path(bundle) / '.venv/lib/python3.12/site-packages') + '\n')
    core.save(target / 'hub-ready.json', json.dumps({'lock_sha256': hashlib.sha256((HERE / 'extras-lock.json').read_bytes()).hexdigest(), 'features': ['browser-packages'], 'tree': _tree(target, Path(bundle) / '.venv/bin/python')}, sort_keys=True))
    shutil.rmtree(temporary)
    return {'installed': [r['name'] + '==' + r['version'] for r in rows], 'network': 'offline', 'browser_execution': False}


def browser_interpreter(bundle, taskroot):
    target = Path(taskroot) / 'extras-browser-venv'
    executable = validate_runtime(bundle, target)
    receipt = checked(target / 'hub-ready.json')
    value = json.loads(receipt.read_text())
    if value.get('features') != ['browser-packages'] or value.get('lock_sha256') != hashlib.sha256((HERE / 'extras-lock.json').read_bytes()).hexdigest() or value.get('tree') != _tree(target, Path(bundle) / '.venv/bin/python'):
        raise ValueError('browser environment changed')
    return executable


def approve_browser_archive(taskroot, candidate, reader=input):
    core = _core()
    value = _local_lock(taskroot)
    browser = value['chromium']
    if browser.get('sha256') is not None:
        raise ValueError('archive already approved; no overwrite')
    if set(candidate) != {'url', 'sha256', 'bytes', 'executable_relative_path'}:
        raise ValueError('exact archive fields required')
    parts = urlsplit(candidate['url'])
    relative = candidate['executable_relative_path']
    if candidate['url'] != browser['url'] or parts.scheme != 'https' or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError('archive URL differs from derived source')
    if not re.fullmatch('[0-9a-f]{64}', candidate['sha256']) or type(candidate['bytes']) is not int or not 0 < candidate['bytes'] <= MAX_ARCHIVE_BYTES:
        raise ValueError('archive hash/size required')
    if not isinstance(relative, str) or relative.startswith('/') or '\\' in relative or any(x in ('', '.', '..') or ':' in x for x in relative.split('/')):
        raise ValueError('unsafe executable relative path')
    if browser.get('executable_relative_path') is not None and relative != browser['executable_relative_path']:
        raise ValueError('archive executable differs from derived source')
    if not _approve({'approve_chromium_archive': candidate, 'derived': browser}, reader):
        return {'cancelled': True}
    browser.update(candidate)
    browser['status'] = 'human approved archive; not installed'
    core.save(Path(taskroot) / 'extras-lock.json', json.dumps(value, sort_keys=True))
    return value


def install_browser_archive(taskroot, archive=None, reader=input):
    core = _core()
    root = Path(taskroot)
    value = _local_lock(root)
    row = value['chromium']
    if any(row.get(k) is None for k in ('sha256', 'bytes', 'url', 'executable_relative_path')):
        raise ValueError('human approved archive metadata required')
    if archive is None:
        archive = root / 'extras-archives' / Path(urlsplit(row['url']).path).name
    archive = checked(archive)
    validate_wheel(archive, {**row, 'filename': Path(urlsplit(row['url']).path).name})
    target = root / 'extras-browser'
    _fresh(target)
    if not _approve({'extract_chromium_archive': row, 'network': 'offline', 'browser_execution': False}, reader):
        return {'cancelled': True}
    target.mkdir(mode=0o700)
    with zipfile.ZipFile(archive) as zf:
        entries = _zip_entries(zf, browser_links=True)
        links = _browser_zip_links(zf, entries)
        for item in entries:
            if item.filename in links:
                continue
            destination = target / item.filename
            if item.is_dir():
                destination.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                mode = item.external_attr >> 16
                with destination.open('xb') as out, zf.open(item) as stream:
                    count = 0
                    for chunk in iter(lambda: stream.read(65536), b''):
                        count += len(chunk)
                        if count > item.file_size:
                            raise ValueError('archive expanded beyond declared size')
                        out.write(chunk)
                destination.chmod(0o700 if mode & 0o111 else 0o600)
        for name, link in links.items():
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            destination.symlink_to(link)
    executable = checked(target / row['executable_relative_path'])
    if not executable.stat().st_mode & stat.S_IXUSR:
        raise ValueError('archive executable is not executable')
    core.save(target / 'hub-ready.json', json.dumps({'archive': row, 'tree': _tree(target, browser_links=True)}, sort_keys=True))
    _facebook_runtime().install_adapter(root)
    return {'installed': 'chromium', 'network': 'offline', 'browser_execution': False, 'adapter': 'verified'}


def validate_browser_archive(taskroot):
    target = Path(taskroot) / 'extras-browser'
    if target.is_symlink() or stat.S_IMODE(target.stat().st_mode) != 0o700:
        raise ValueError('unsafe browser root')
    value = json.loads(checked(target / 'hub-ready.json').read_text())
    if value['archive'] != _local_lock(taskroot)['chromium'] or value['tree'] != _tree(target, browser_links=True):
        raise ValueError('browser archive tree changed')
    return target / value['archive']['executable_relative_path']


def _facebook_runtime():
    import importlib.util
    spec = importlib.util.spec_from_file_location('hub_fb_adapter', HERE / 'facebook_runtime.py')
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    return runtime


def download_candidate(taskroot):
    root = Path(taskroot)
    path = checked(root / 'chromium-download/archive-candidate.json')
    receipt = checked(root / 'chromium-download/receipt.json')
    if path.stat().st_size > 65536 or receipt.stat().st_size > 65536:
        raise ValueError('download candidate quota')
    candidate = json.loads(path.read_text(), object_pairs_hook=_unique_pairs)
    if json.loads(receipt.read_text(), object_pairs_hook=_unique_pairs).get('candidate') != candidate:
        raise ValueError('download candidate differs from receipt')
    browser = _local_lock(root)['chromium']
    if candidate.get('url') != browser['url'] or candidate.get('executable_relative_path') != browser['executable_relative_path']:
        raise ValueError('download candidate differs from derived metadata')
    validate_wheel(root / 'extras-archives' / Path(urlsplit(browser['url']).path).name,
                   {**candidate, 'filename': Path(urlsplit(browser['url']).path).name})
    return candidate

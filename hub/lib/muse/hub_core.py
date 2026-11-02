"""Task-scoped MetaMuse bridge. Loaded only by the pinned, sandboxed interpreter.

Approval is exposed only to the human UI control plane, never the AI request/MCP tools. The upstream schemas,
idempotency keys, grant consumption and uncertain-delivery rules remain authoritative.
"""
import argparse
import contextlib
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import stat
import sqlite3
import sys
import time
import unicodedata

from metamuse import app, content, models as m, safety
from metamuse import _muse_research as research
from metamuse.config import Config, load_config
from metamuse.store import Store
from metamuse.jobs import Executor, OPERATIONS
import tomlkit

_fb_spec = importlib.util.spec_from_file_location('hub_facebook_runtime', Path(__file__).with_name('facebook_runtime.py'))
_fb_runtime = importlib.util.module_from_spec(_fb_spec)
_fb_spec.loader.exec_module(_fb_runtime)
FACEBOOK_BLOCKERS = _fb_runtime.BLOCKERS
is_facebook_collection = _fb_runtime.is_facebook_collection
require_supported_runtime = _fb_runtime.require_supported_runtime

REMOTE = {'metamuse_muse_open': 'access_grant_id', 'metamuse_muse_send': 'share_grant_id',
          'metamuse_muse_read': 'access_grant_id', 'metamuse_collect': 'access_grant_id',
          'metamuse_publication_submit': 'publication_grant',
          'metamuse_publication_reconcile': 'publication_grant'}

def external_component_status():
    lock = json.loads(Path(__file__).with_name('extras-lock.json').read_text())
    return {'manifest': 'extras-lock.json', 'download_approval_required': True,
            'chromium': lock['chromium'], 'facebook_blockers': FACEBOOK_BLOCKERS,
            'facebook_profile': {'file': 'hub-fb-live.sb', 'enabled': False, 'activation': 'only after task runtime verification', 'reason': 'verified Mac exec adapter and FB-only IPv4 loopback profile'},
            'notice': 'URL/API wiring is implemented. Browser collection requires verified installed components and separate human approval; fixture success is not a live-service result.'}


def safe_text(value):
    value = safety.redact_display(str(value))
    return ''.join(c if c in '\n\t' or unicodedata.category(c) not in ('Cc', 'Cf')
                   else '\\u%04x' % ord(c) for c in value)


def emit(value):
    if hasattr(value, 'model_dump'):
        value = value.model_dump(mode='json')
    # JSON escapes controls; redact credential-shaped text in all nested values.
    def clean(v):
        if hasattr(v, 'model_dump'):
            v = v.model_dump(mode='json')
        if isinstance(v, str):
            return safe_text(v)
        if isinstance(v, dict):
            return {k: clean(x) for k, x in v.items() if k not in ('auth_ref', 'cookie', 'storage_state', 'access_token')}
        if isinstance(v, list):
            return [clean(x) for x in v]
        return v
    print(json.dumps(clean(value), ensure_ascii=False))


def credential_text(raw):
    """Conservative intake check, not a promise to recognize every arbitrary secret."""
    return bool(re.search(rb'(?i)("(?:cookies|origins|access_token|refresh_token|storage_state)"\s*:|authorization\s*[:=]\s*bearer|(?:c_user|datr|xs)=|-----BEGIN [A-Z ]*PRIVATE KEY)', raw)
                or re.fullmatch(rb'[A-Za-z0-9_+/=.-]{32,}\s*', raw))


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate key')
        result[key] = value
    return result


def checked(path, directory=False):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('absolute, normalized path required')
    current = Path('/')
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError('linked path')
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('owner or permissions')
    if directory:
        if not path.is_dir():
            raise ValueError('directory')
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('regular file')
    return path


def private_dir(path):
    path = Path(path)
    if not path.exists():
        if path.parent.exists():
            checked(path.parent, True)
        else:
            private_dir(path.parent)
        path.mkdir(mode=0o700)
    checked(path, True)
    if stat.S_IMODE(path.stat().st_mode) != 0o700:
        raise ValueError('private directory must be 700')


def save(path, value):
    path = Path(path)
    if path.exists():
        checked(path)
        if stat.S_IMODE(path.stat().st_mode) != 0o600:
            raise ValueError('private file')
    temporary = path.with_name(path.name + '.new')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(value)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


@contextlib.contextmanager
def locked(path, *, create=True):
    flags = os.O_RDWR | os.O_CREAT if create else os.O_RDONLY
    fd = os.open(path, flags | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise ValueError('lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


class ReadOnlySecrets:
    """Reuse an explicitly bound legacy Muse credential; never enumerate or mutate it."""
    def __init__(self, root, binding):
        self.store = safety.SecretStore(root / 'auth')
        self.ref = binding.auth_ref

    def resolve(self, ref, **kwargs):
        if ref != self.ref:
            raise ValueError('unbound credential')
        return self.store.resolve(ref, **kwargs)

    def put(self, *args, **kwargs):
        raise ValueError('legacy credential is read-only')

    def revoke(self, *args, **kwargs):
        raise ValueError('legacy credential is read-only')


class TaskSecrets:
    def __init__(self, root, legacy=None):
        self.local = safety.SecretStore(root / 'auth')
        self.legacy = legacy

    def resolve(self, ref, **kwargs):
        if self.legacy and ref == self.legacy.ref:
            return self.legacy.resolve(ref, **kwargs)
        return self.local.resolve(ref, **kwargs)

    def put(self, *args, **kwargs):
        return self.local.put(*args, **kwargs)

    def list(self, *args, **kwargs):
        return self.local.list(*args, **kwargs)

    def revoke(self, ref):
        if self.legacy and ref == self.legacy.ref:
            raise ValueError('use the existing Muse settings to manage the legacy binding')
        return self.local.revoke(ref)


class PreviewStore(Store):
    """Existing database only: no initialization, migrations, keys or write connection."""
    def __init__(self, paths):
        self.paths = paths
        self.clock = m.utc_now if hasattr(m, 'utc_now') else lambda: datetime.now(timezone.utc).isoformat()

    @contextlib.contextmanager
    def connection(self):
        checked(self.paths.database)
        # Normal SQLite read-only mode may still create/write WAL sidecars. The
        # shared bridge lock excludes writers; require a checkpointed database
        # before using immutable mode, which would otherwise ignore pending WAL.
        if os.path.lexists(str(self.paths.database) + '-wal'):
            raise ValueError('preview requires a closed, checkpointed workspace')
        conn = sqlite3.connect(self.paths.database.as_uri() + '?mode=ro&immutable=1', uri=True, isolation_level=None)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute('PRAGMA query_only=ON')
            yield conn
        finally:
            conn.close()

    @contextlib.contextmanager
    def transaction(self):
        raise ValueError('preview is read only')
        yield


class Bridge:
    def __init__(self, taskroot, project_dir, inputs, legacy, project, task, *, binding=None, fixture=False):
        self.root, self.project_dir, self.inputs, self.legacy = map(Path, (taskroot, project_dir, inputs, legacy))
        self.project, self.task, self.binding, self.fixture = project, task, binding, fixture
        self.ctx = None

    save_private = staticmethod(save)

    def material(self, path):
        path = checked(Path(path))
        roots = [self.project_dir, self.inputs, self.root / 'inputs']
        if not any(path.is_relative_to(root) for root in roots):
            raise ValueError('input is outside this project and inputs')
        if any(x in ('.git', '.env', 'auth', 'workspace-muse', 'trial-v1', 'credential-intake') for x in path.parts):
            raise ValueError('private input')
        if re.search(r'(?i)(?:^|[._-])(?:credentials?|cookies?|tokens?|storage[-_]?state|secrets?|auth)(?:$|[._-])', path.name):
            raise ValueError('credential-like input name; use credential-intake only')
        with path.open('rb') as source:
            previous = b''
            while chunk := source.read(65536):
                if credential_text(previous + chunk):
                    raise ValueError('credential-like material cannot be imported')
                previous = chunk[-1024:]
        return path

    def request(self, path, *, with_sha=False, private=False):
        path = self.material(path)
        return self._read_request(path, with_sha=with_sha, private=private)

    def issued_marker(self, approval_id):
        if not re.fullmatch(r'direct_[a-f0-9-]{36}', approval_id):
            raise ValueError('direct issue marker id')
        # A fixed internal record, not a newly allowed material/search root.
        return self._read_request(checked(self.root / ('approval-issued-' + approval_id + '.json')),
                                  with_sha=True, private=True)

    def _read_request(self, path, *, with_sha=False, private=False):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as source:
            before = os.fstat(source.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.getuid() or before.st_mode & 0o022:
                raise ValueError('request file')
            if private and stat.S_IMODE(before.st_mode) != 0o600:
                raise ValueError('private request file')
            raw = source.read(2 * 1024 * 1024 + 1)
            after = os.fstat(source.fileno())
            if len(raw) > 2 * 1024 * 1024 or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('request changed or too large')
        value = json.loads(raw, object_pairs_hook=no_duplicates)
        if not isinstance(value, dict):
            raise ValueError('request object')
        return (value, hashlib.sha256(raw).hexdigest()) if with_sha else value

    @contextlib.contextmanager
    def open(self, online=False, *, direct=False):
        private_dir(self.root)
        private_dir(self.root / 'inputs')
        private_dir(self.root / 'credential-intake')
        with locked(self.root / 'bridge.lock'):
            # A lock shared with registration prevents update/disconnect during a live job.
            with locked(self.legacy / '.registration.lock'):
                mapping_file = self.root / 'binding.json'
                if os.path.lexists(mapping_file):
                    checked(mapping_file)
                    if mapping_file.stat().st_size > 16384:
                        raise ValueError('binding')
                    old_mapping = json.loads(mapping_file.read_text())
                    if old_mapping.get('project') != self.project or old_mapping.get('task') != self.task:
                        raise ValueError('task binding changed')
                workspace = self.root / 'workspace'
                if workspace.exists():
                    self.validate_tree(workspace)
                private_dir(workspace)
                self.ctx = app.AppContext.open(workspace)
                self.ctx.non_interactive = True
                app.register_builtin_operations()
                config = load_config(workspace)
                config.app.network_mode = 'live' if online else 'offline'
                config.app.telemetry_enabled = False
                config.app.import_roots = [str(self.project_dir), str(self.inputs), str(self.root / 'inputs')]
                config.limits.safe_read_retries = 0
                # Always reset the persisted value for this entry point. Human
                # direct turns must not enlarge subsequent research/MCP limits.
                config.limits.max_exchanges = 30 if direct else 3
                config.facebook.allow_unsandboxed_browser = False
                config.muse.enabled, config.muse.backend = False, 'live'
                self.ctx.secret_store = TaskSecrets(self.root)
                if self.binding:
                    config.muse.enabled = True
                    config.muse.binding = self.binding
                    self.ctx.secret_store = TaskSecrets(self.root, ReadOnlySecrets(self.legacy, self.binding))
                if self.fixture:
                    from metamuse._muse_fixture import OfflineMuseGateway
                    config.muse.enabled, config.muse.backend = True, 'fixture'
                    self.ctx.muse_gateway = OfflineMuseGateway(self.ctx.store)
                from metamuse import facebook
                facebook.set_secret_store_factory(lambda: self.ctx.secret_store)
                try:
                    self.write_config(config)
                    result = app.create_project(self.ctx, {'name': self.project + ' / ' + self.task,
                                                            'request_key': 'hub-project-v1'})
                    if result.status != 'ok':
                        raise ValueError('project mapping')
                    self.project_id = result.data['id']
                    mapping = {'version': 1, 'project': self.project, 'task': self.task, 'project_id': self.project_id}
                    if mapping_file.exists() and json.loads(mapping_file.read_text()) != mapping:
                        raise ValueError('task binding changed')
                    save(mapping_file, json.dumps(mapping) + '\n')
                    yield self
                finally:
                    final_config = load_config(workspace)
                    final_config.app.network_mode = 'offline'
                    final_config.app.telemetry_enabled = False
                    self.write_config(final_config)
                    facebook.set_secret_store_factory(None)
                    self.ctx = None

    @contextlib.contextmanager
    def open_preview(self):
        # Existing locks only: a GET neither creates nor rewrites task data.
        with locked(self.root / 'bridge.lock', create=False), locked(self.legacy / '.registration.lock', create=False):
            # AI preparation must already have initialized this task. A GET never does it.
            from metamuse.paths import WorkspacePaths
            workspace = checked(self.root / 'workspace', True)
            self.validate_tree(workspace)
            mapping = json.loads(checked(self.root / 'binding.json').read_text())
            if mapping.get('project') != self.project or mapping.get('task') != self.task:
                raise ValueError('task binding')
            self.project_id = mapping['project_id']
            paths = WorkspacePaths.resolve(workspace)
            policy = load_config(workspace)
            # A read-only research preview must not inherit a preceding direct
            # turn's persisted 30. Do not write configuration during inspection.
            policy.limits.max_exchanges = 3
            self.ctx = app.AppContext(paths=paths, store=PreviewStore(paths), policy=policy, limits=policy.limits,
                                      non_interactive=True)
            self.ctx.secret_store = TaskSecrets(self.root, ReadOnlySecrets(self.legacy, self.binding) if self.binding else None)
            if self.fixture:
                from metamuse._muse_fixture import OfflineMuseGateway
                self.ctx.muse_gateway = OfflineMuseGateway(self.ctx.store)
            try:
                yield self
            finally:
                self.ctx = None
    @contextlib.contextmanager
    def approval_policy(self):
        # Upstream review requires interactive/live policy even though this process
        # is OS network-denied. Keep that policy in memory, never in configuration.
        # Upstream callbacks reread config (including function-local imports).
        # Overlay only bridge-owned fields in this isolated process, preserving
        # the freshly read allowlists, account bindings and limits for each call.
        from metamuse import config as config_module, remote_media, publishing
        modules = (config_module, research, remote_media, publishing)
        loaders = [(module, module.load_config) for module in modules]
        old, loader = self.ctx.policy, load_config
        def approval_config(root):
            fresh = loader(root)
            if Path(root) == self.ctx.paths.root:
                fresh.limits.max_exchanges = self.ctx.limits.max_exchanges
                fresh.app.network_mode = 'live'
                fresh.muse.enabled = bool(self.binding) or self.fixture
                fresh.muse.backend = 'fixture' if self.fixture else 'live'
                if self.binding:
                    fresh.muse.binding = self.binding
            return fresh
        previous = self.ctx.non_interactive
        self.ctx.policy, self.ctx.non_interactive = approval_config(self.ctx.paths.root), False
        for module, _ in loaders:
            module.load_config = approval_config
        try:
            yield
        finally:
            for module, original in loaders:
                module.load_config = original
            self.ctx.policy, self.ctx.non_interactive = old, previous

    def approval(self, kind, request, checked_digest=None):
        if kind not in ('research', 'permit'):
            raise ValueError('approval kind')
        with self.approval_policy():
            if kind == 'research':
                if set(request) != {'open_request', 'packet_id', 'rounds', 'max_reads', 'expires_at', 'request_key'}:
                    raise ValueError('research schema')
                opening = self.normalize('metamuse_muse_open', request['open_request'])
                with self.ctx.store.connection() as conn:
                    review = research.prepare_research(self.ctx, opening, **{k: v for k, v in request.items() if k != 'open_request'}, conn=conn)
                preview = research.preview(self.ctx, review)
                packet = self.ctx.store.get(m.Packet, request['packet_id'])
                text = packet.rendered_text
            else:
                if set(request) != {'operation', 'request', 'expires_at', 'request_key', 'max_uses'}:
                    raise ValueError('approval schema')
                if request['operation'] not in ('muse.open', 'muse.send', 'muse.read', 'collect.remote', 'publication.send', 'publication.reconcile'):
                    raise ValueError('operation is not available')
                preview = safety.approval_preview(self.ctx, request['operation'], request['request'])
                packet_id = request['request'].get('packet_id')
                text = self.ctx.store.get(m.Packet, packet_id).rendered_text if packet_id else ''
            if preview.project_id != self.project_id:
                raise ValueError('different task project')
            expiry = safety._timestamp(request['expires_at'])
            if expiry <= safety._timestamp(self.ctx.clock()):
                raise ValueError('expired approval')
            # Bind expiry, budgets and request key as well as upstream action identity.
            digest = m.payload_digest({'action': preview.action_digest, 'request': request})
            if checked_digest is None:
                return {'action_digest': digest, 'destination': preview.destination,
                        'topic': preview.topic or '', 'packet_full_text': text,
                        'request': opening if kind == 'research' else preview.request, 'summary': preview.summary,
                        'expires_at': request['expires_at'], 'rounds': request.get('rounds', request.get('max_uses')),
                        'max_reads': request.get('max_reads', 0), 'kind': kind}
            if not re.fullmatch('[a-f0-9]{64}', checked_digest) or checked_digest != digest:
                raise ValueError('approval changed')
            if kind == 'research':
                return research.issue_research(self.ctx, review)
            return safety.approve_permit(self.ctx, preview, expires_at=request['expires_at'],
                                         request_key=request['request_key'], max_uses=request['max_uses'])

    def approval_file(self, path, checked_digest=None):
        envelope, request_sha = self.request(path, with_sha=True)
        if envelope.get('schema') != 1 or envelope.get('project') != self.project or envelope.get('task') != self.task:
            raise ValueError('approval context')
        if checked_digest is not None:
            self.reserve_approval_issue(path, envelope, request_sha, checked_digest)
        return self.approval(envelope['kind'], envelope['request'], checked_digest)

    def reserve_approval_issue(self, path, envelope, request_sha, digest, *, validate_only=False):
        """Require the Hub's durable decision intent, then burn this ID before issuance.

        This binds the control CLI to the human UI flow; it does not authenticate
        a different human against other processes running as the same OS user.
        Never remove the marker, including when upstream issuance or its reply fails.
        """
        approval_id = envelope.get('id')
        if not isinstance(approval_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', approval_id):
            raise ValueError('approval id')
        directory = self.project_dir / '.ai' / 'muse-approvals'
        if Path(path) != directory / (approval_id + '.json'):
            raise ValueError('approval request location')
        reservation = directory / '.decisions' / self.task / (approval_id + '.json')
        decision = self.request(reservation, private=True)
        if (decision.get('schema') != 1 or decision.get('project') != self.project or
                decision.get('task') != self.task or decision.get('id') != approval_id or
                decision.get('decision') != 'approve' or decision.get('state') != 'unknown' or
                'grant' in decision or decision.get('digest') != digest or decision.get('requestSHA') != request_sha):
            raise ValueError('approval decision reservation')
        at = decision.get('at')
        if not isinstance(at, str):
            raise ValueError('approval decision time')
        instant = datetime.fromisoformat(at.replace('Z', '+00:00'))
        if instant.tzinfo is None or not 0 <= (datetime.now(timezone.utc) - instant).total_seconds() < 600:
            raise ValueError('expired approval decision')
        if validate_only:
            return
        checked(self.root, True)
        marker = self.root / ('approval-issued-' + approval_id + '.json')
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump({'schema': 1, 'project': self.project, 'task': self.task, 'id': approval_id,
                       'digest': digest, 'requestSHA': request_sha, 'at': at}, out)
            out.flush()
            os.fsync(out.fileno())
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    @staticmethod
    def validate_tree(root):
        checked(root, True)
        for parent, dirs, files in os.walk(root, followlinks=False):
            for name in dirs:
                checked(Path(parent) / name, True)
            for name in files:
                checked(Path(parent) / name)

    def write_config(self, config):
        save(self.ctx.paths.root / 'metamuse.toml', tomlkit.dumps(config.model_dump(exclude_none=True)))
        self.ctx.policy = config
        self.ctx.limits = config.limits

    @contextlib.contextmanager
    def review_policy(self, enabled):
        """Read-only upstream remote review under an OS network-denied profile."""
        old = load_config(self.ctx.paths.root)
        if enabled:
            reviewing = old.model_copy(deep=True)
            reviewing.app.network_mode = 'live'
            self.write_config(reviewing)
        try:
            yield
        finally:
            if enabled:
                self.write_config(old)

    def normalize(self, tool, request):
        if tool not in m.TOOL_REQUEST_MODELS:
            raise ValueError('operation is not available')
        request = dict(request)
        model = m.TOOL_REQUEST_MODELS[tool]
        if 'project_id' in model.model_fields:
            if request.get('project_id', self.project_id) != self.project_id:
                raise ValueError('different task project')
            request['project_id'] = self.project_id
        if tool == 'metamuse_project_create':
            raise ValueError('project is managed by Hub task binding; use history')
        if tool == 'metamuse_collect':
            for source in request.get('inputs', []):
                if source.get('kind') == 'text' and credential_text(source.get('text', '').encode()):
                    raise ValueError('credential-like text cannot be imported')
                if source.get('kind') == 'local_file':
                    self.material(source['path'])
            if not any(x.get('kind') == 'url' for x in request.get('inputs', [])) and request.get('access_grant_id') is not None:
                raise ValueError('local collection requires no grant')
        if tool == 'metamuse_job_control' and request.get('operation') == 'cancel':
            raise ValueError('cancellation requires the human terminal')
        return model.model_validate(request, context={'limits': self.ctx.limits}).model_dump(mode='python')

    def live_grant(self, tool, request):
        if tool not in REMOTE or (tool == 'metamuse_muse_read' and not request.get('refresh')):
            return False
        if tool == 'metamuse_collect' and not any(x.get('kind') == 'url' for x in request.get('inputs', [])):
            return False
        grant_id = request.get(REMOTE[tool])
        if not grant_id:
            return False  # Upstream returns the exact approval.request without sending.
        with self.ctx.store.connection() as conn:
            permit = self.ctx.store.get(m.Permit, grant_id, conn=conn)
        kind = ('publication' if tool.startswith('metamuse_publication_') else
                'share' if tool == 'metamuse_muse_send' else 'access')
        if (permit.project_id != self.project_id or permit.kind != kind or permit.revoked
                or permit.used >= permit.max_uses or datetime.fromisoformat(permit.expires_at) <= datetime.now(timezone.utc)):
            raise ValueError('grant is expired, revoked, exhausted or belongs to another task')
        return True

    def call(self, tool, request, run=False, online=False):
        request = self.normalize(tool, request)
        need_live = self.live_grant(tool, request)
        if need_live and not (online or self.fixture):
            raise ValueError('approved operation requires the live launcher')
        if online and not need_live:
            raise ValueError('live mode requires an existing grant')
        if need_live and not self.fixture and is_facebook_collection(tool, request):
            cache = require_supported_runtime(self.root, self.inputs.parent)
            if os.environ.get('PLAYWRIGHT_BROWSERS_PATH') != str(cache):
                raise ValueError('Facebook requires verified task cache environment')
        if tool == 'metamuse_job_control':
            with self.ctx.store.connection() as conn:
                job = self.ctx.store.get(m.Job, request['job_id'], conn=conn)
            if job.operation.startswith(('muse.', 'publication.', 'collect.remote', 'collect.facebook')):
                raise ValueError('do not resume remote jobs; read cached results or reconcile')
        # Remote preview is read-only but upstream requires its policy to say live.
        # This process still has the network-denied OS profile unless a grant passed preflight.
        preview_remote = tool == 'metamuse_collect' and any(x.get('kind') == 'url' for x in request.get('inputs', []))
        with self.review_policy(preview_remote and not online):
            result = app.TOOL_FUNCTIONS[tool](self.ctx, request)
            job_id = (result.data.get('job_id') or result.data.get('refresh_job_id')) if isinstance(result.data, dict) else None
            if run and job_id and result.status in ('accepted', 'ok'):
                self.run_job(job_id)
                final = app.get_job(self.ctx, {'job_id': job_id})
                result = result.model_copy(update={'data': {**result.data, **final.data}})
        if tool.startswith('metamuse_muse_'):
            result = result.model_copy(update={'warnings': [*result.warnings,
                '合成試験の返答です。実アカウントではありません。' if self.fixture else
                'Museの返答は外部の参考資料です。返答受領と回答完了は別です。実サービスの回答完了は自動確認できません。']})
        return result

    def run_job(self, job_id):
        with self.ctx.store.connection() as conn:
            job = self.ctx.store.get(m.Job, job_id, conn=conn)
            others = conn.execute("SELECT id FROM jobs WHERE id<>? AND state IN ('queued','running')", (job_id,)).fetchall()
        if others:
            raise ValueError('another queued job exists; handle it before running this job')
        registry = {job.operation: OPERATIONS[job.operation]}
        if job.operation == 'publication.reconcile':
            # Upstream settle_uncertain needs the original send's on_finish hook.
            # No other queued/running job is allowed above; this never resubmits it.
            registry['publication.send'] = OPERATIONS['publication.send']
        deadline = time.monotonic() + self.ctx.limits.wall_clock_seconds
        with Executor(self.ctx.store, registry=registry, non_interactive=True,
                      muse_gateway=self.ctx.muse_gateway, publishing_gateway=self.ctx.publishing_gateway,
                      secret_store=self.ctx.secret_store) as worker:
            for _ in range(64):
                if time.monotonic() >= deadline or not worker.run_once():
                    break
                with self.ctx.store.connection() as conn:
                    current = self.ctx.store.get(m.Job, job_id, conn=conn)
                if current.state not in ('queued', 'running'):
                    break
        # No detached worker and no automatic resume/retry for unknown delivery.

    def permits(self):
        with self.ctx.store.connection() as conn:
            rows = conn.execute('SELECT * FROM permits WHERE project_id=? ORDER BY rowid', (self.project_id,)).fetchall()
            permits = [self.ctx.store.decode(m.Permit, row) for row in rows]
        return {'permits': [{'id': p.id, 'kind': p.kind, 'expires_at': p.expires_at,
                             'remaining': max(0, p.max_uses - p.used), 'revoked': p.revoked,
                             'target': p.provider or 'Muse', 'account': p.account}
                            for p in permits]}

    def history(self):
        with self.ctx.store.connection() as conn:
            discussions = [self.ctx.store.decode(m.Discussion, x).model_dump(mode='json') for x in conn.execute('SELECT * FROM discussions ORDER BY rowid')]
            exchanges = [self.ctx.store.decode(m.Exchange, x).model_dump(mode='json') for x in conn.execute('SELECT * FROM exchanges ORDER BY rowid')]
        return {'binding': {'project': self.project, 'task': self.task, 'project_id': self.project_id},
                'discussions': discussions, 'exchanges': exchanges,
                'notice': '外部の返答は参考資料です。実サービスの回答完了は自動確認できません。'}

    def preview_packet(self, packet_id):
        return content.preview_packet(self.ctx, packet_id)

    def human(self, reader=input):
        if not all(s.isatty() for s in (sys.stdin, sys.stdout, sys.stderr)):
            raise ValueError('human terminal required')
        self.ctx.non_interactive = False
        print('MetaMuse：本人用の承認・許可管理（15のみ承認後に通信）')
        print('1 研究範囲の承認  2 個別操作の承認  3 許可一覧  4 許可取消  5 処理取消')
        print('6 この作業の追加認証一覧  7 追加認証取消  8 Facebook/Page認証登録  9 動画収集の接続先設定  10 取得済み動画用部品の導入')
        print('11 取得済みブラウザ用wheelの導入  12 固定wheelのブラウザ情報を確認  13 ブラウザ配布物の固定値を登録  14 取得済みブラウザの展開  15 Chromiumの照会・取得（別承認）  0 終了')
        print('16 未完了の動画用環境を別名保管（通信・削除・再導入なし、本人確認）')
        operation = reader('番号: ').strip()
        if operation == '15':
            return {'next_action': 'human_chromium_download_approval', 'network_started': False}
        if operation == '0':
            return {'cancelled': True}
        if operation == '3':
            return self.permits()
        if operation == '4':
            grant = reader('この作業の許可ID: ').strip()
            if grant not in {x['id'] for x in self.permits()['permits']}:
                raise ValueError('grant')
            if reader('取消は REVOKE: ') != 'REVOKE':
                return {'cancelled': True}
            return safety.revoke_permit(self.ctx, grant, request_key=m.new_id('revoke'))
        if operation == '5':
            job_id = reader('この作業の処理ID: ').strip()
            if reader('処理を取り消す場合 CANCEL: ') != 'CANCEL':
                return {'cancelled': True}
            return app.control_job(self.ctx, {'job_id': job_id, 'operation': 'cancel', 'request_key': m.new_id('cancel')})
        if operation == '6':
            # The reused Muse credential is intentionally not enumerated or opened.
            if not (self.root / 'auth').exists():
                return {'credentials': [], 'legacy_muse': bool(self.binding), 'contents_read': False}
            rows = safety.list_auth(self.ctx).data['references']
            return {'credentials': [{**{k: v for k, v in row.items() if k != 'auth_ref'},
                                     'credential_id': row['auth_ref']} for row in rows], 'legacy_muse': bool(self.binding)}
        if operation == '7':
            ref = reader('この作業の追加認証ID: ').strip()
            if self.binding and ref == self.binding.auth_ref:
                raise ValueError('legacy binding is read-only here')
            if reader('この作業の認証取消は REVOKE: ') != 'REVOKE':
                return {'cancelled': True}
            return safety.revoke_auth(self.ctx, ref)
        if operation in ('10', '11', '12', '13', '14', '16'):
            import importlib.util
            spec = importlib.util.spec_from_file_location('hub_extras', Path(__file__).with_name('extras.py'))
            extra = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(extra)
            if operation == '16':
                return extra.preserve_incomplete_video(self.inputs.parent, self.root, reader)
            if operation == '10':
                return extra.install_video(self.inputs.parent, self.root, reader)
            if operation == '11':
                return extra.install_browser(self.inputs.parent, self.root, reader)
            if operation == '12':
                return extra.derive_browser_metadata(self.root, reader)
            if operation == '13':
                path = reader('固定値JSON（空欄なら15で取得・照合した候補）: ').strip()
                candidate = self.request(path) if path else extra.download_candidate(self.root)
                return extra.approve_browser_archive(self.root, candidate, reader)
            return extra.install_browser_archive(self.root, reader=reader)
        if operation == '9':
            from metamuse.config import RemoteApproval
            request = self.request(reader('動画収集の接続先設定JSON（extractor/hosts。秘密なし）: ').strip())
            if set(request) != {'approvals'} or not isinstance(request['approvals'], list):
                raise ValueError('remote allowlist schema')
            approvals = [RemoteApproval.model_validate(x) for x in request['approvals']]
            if any(x.auth_ref for x in approvals) or len(approvals) > 32:
                raise ValueError('cookie-based remote media is not enabled')
            from metamuse.config import validate_facebook_hosts
            # Same strict public DNS-host syntax as Facebook; never IP/wildcard/local names.
            for entry in approvals:
                validate_facebook_hosts(entry.hosts)
            emit({'remote_media': [x.model_dump() for x in approvals], 'notice': 'この設定だけでは取得しません。各URLに別の承認が必要です。'})
            if reader('この接続先設定を保存する場合 CONFIGURE: ') != 'CONFIGURE':
                return {'cancelled': True}
            config = load_config(self.ctx.paths.root)
            config.remote_media.approvals = approvals
            self.write_config(config)
            return {'configured': True, 'network': 'offline'}
        if operation == '8':
            from metamuse.connect import ConnectRequest, connect_account
            service = reader('サービス（facebook または publishing）: ').strip()
            if service not in ('facebook', 'publishing'):
                raise ValueError('service')
            config = load_config(self.ctx.paths.root)
            previous = getattr(config, service)
            if previous.auth_ref and os.path.lexists(self.root / 'auth' / (previous.auth_ref + '.json')):
                raise ValueError('existing service binding requires explicit cleanup first')
            account = reader('アカウントの管理用の名前（秘密は入力しない）: ').strip()
            path = checked(Path(reader('私用領域の credential-intake に本人が置いた認証ファイルの絶対パス: ').strip()))
            if not path.is_relative_to(self.root / 'credential-intake') or stat.S_IMODE(path.stat().st_mode) != 0o600:
                raise ValueError('credential input must be private and outside Git')
            page_id = reader('投稿先Pageの数字ID: ').strip() if service == 'publishing' else None
            api_version = reader('利用するGraph API版（例 v25.0、本人が公式情報で確認）: ').strip() if service == 'publishing' else None
            print('通信なしで、この作業専用に平文保存します。元の認証ファイルは自動削除しません。')
            if reader('了承して登録する場合 CONNECT: ') != 'CONNECT':
                return {'cancelled': True}
            result = connect_account(self.ctx, ConnectRequest(service=service, account=account, auth_file=str(path),
                                   page_id=page_id, api_version=api_version, enable_network=False))
            print('受取ファイルは credential-intake に残っています。登録結果を確認後、本人がそのファイルだけを削除してください。資料用 inputs へ移さないでください。')
            return result
        request = self.request(reader('承認用JSONファイルの絶対パス（秘密は入れない）: ').strip())
        if operation in ('1', '2'):
            kind = 'research' if operation == '1' else 'permit'
            preview = self.approval(kind, request)
            emit({'approval': preview, 'packet_full_text': preview['packet_full_text'],
                  'notice': '全文と送り先を確認してください。承認だけでは送信しません。'})
            if reader('了承する場合は上の action_digest を省略せず入力: ') != preview['action_digest']:
                return {'cancelled': True}
            return self.approval(kind, request, preview['action_digest'])
        raise ValueError('menu')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--taskroot')
    parser.add_argument('--project-dir')
    parser.add_argument('--inputs')
    parser.add_argument('--legacy', required=True)
    parser.add_argument('--project')
    parser.add_argument('--task')
    parser.add_argument('--mode', choices=('offline', 'check', 'live'), default='offline')
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--checked-digest')
    parser.add_argument('operation')
    parser.add_argument('request', nargs='?')
    args = parser.parse_args()
    if args.operation in ('usage-read', 'usage-status'):
        if any(v is not None for v in (args.taskroot, args.project_dir, args.inputs, args.project, args.task)):
            parser.error('usage operations have no project/task context')
        spec = importlib.util.spec_from_file_location('hub_usage', Path(__file__).with_name('usage.py'))
        usage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(usage)
        emit(usage.control(sys.modules[__name__], args))
        return
    if any(v is None for v in (args.taskroot, args.project_dir, args.inputs, args.project, args.task)):
        parser.error('--taskroot, --project-dir, --inputs, --project and --task are required for task operations')
    # Read only the known legacy configuration, never scan auth/browser directories.
    binding = None
    config = Path(args.legacy) / 'workspace-muse' / 'metamuse.toml'
    if config.exists():
        checked(config)
        old = load_config(config.parent)
        if old.app.network_mode != 'offline' or old.app.telemetry_enabled:
            raise ValueError('legacy configuration')
        binding = old.muse.binding if old.muse.enabled else None
    bridge = Bridge(args.taskroot, args.project_dir, args.inputs, args.legacy, args.project, args.task, binding=binding)
    if args.operation in ('approval-preview', 'approval-issue') and (args.mode != 'offline' or args.run):
        raise ValueError('approval requires offline control plane')
    if args.operation == 'approval-issue' and not args.checked_digest:
        raise ValueError('checked digest required')
    if args.operation == 'direct-inspect' and (args.mode != 'offline' or args.run or args.checked_digest):
        raise ValueError('recovery inspection is local read only')
    with bridge.open_preview() if args.operation in ('approval-preview', 'direct-inspect') else bridge.open(online=args.mode == 'live', direct=args.operation in ('direct-chat', 'direct-read', 'direct-poll')):
        if args.operation in ('direct-chat', 'direct-read', 'direct-poll', 'direct-inspect'):
            spec = importlib.util.spec_from_file_location('hub_direct_chat', Path(__file__).with_name('direct_chat.py'))
            direct = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(direct)
            if args.operation == 'direct-inspect':
                emit(direct.inspect_delivery(bridge, Path(args.request)))
                return
            envelope, request_sha = bridge.request(args.request, with_sha=True, private=True)
            if envelope.get('kind') != ('direct' if args.operation == 'direct-chat' else args.operation):
                raise ValueError('direct operation and request kind differ')
            request = (direct.validate_read if args.operation in ('direct-read', 'direct-poll') else direct.validate)(bridge, envelope)
            digest = m.payload_digest(request)
            if args.mode == 'check':
                bridge.reserve_approval_issue(args.request, envelope, request_sha, digest, validate_only=True)
                emit({'live': True, 'digest': digest})
            else:
                if args.mode != 'live' or args.checked_digest != digest or not args.run:
                    raise ValueError('direct chat requires checked human send')
                bridge.reserve_approval_issue(args.request, envelope, request_sha, digest)
                emit((direct.execute_read if args.operation in ('direct-read', 'direct-poll') else direct.execute)(bridge, envelope))
        elif args.operation in ('approval-preview', 'approval-issue'):
            emit(bridge.approval_file(args.request, args.checked_digest if args.operation == 'approval-issue' else None))
        elif args.operation == 'schemas':
            emit({'tools': {k: v.model_json_schema() for k, v in m.TOOL_REQUEST_MODELS.items()},
                  'stage_two_pending': [], 'external_components': external_component_status(),
                  'project_id': bridge.project_id})
        elif args.operation == 'history':
            emit(bridge.history())
        elif args.operation == 'permits':
            emit(bridge.permits())
        elif args.operation == 'doctor':
            emit({'project_id': bridge.project_id, 'network': 'offline', 'detached_worker': False,
                  'legacy_muse_binding': bool(binding), 'fixed_version': '0.1.0a2',
                  'stage_two_pending': [], 'external_components': external_component_status(),
                  'limits': bridge.ctx.limits.model_dump(), 'capabilities': app.inspect_capabilities(bridge.ctx, {}).model_dump(mode='json')})
        elif args.operation == 'packet-preview':
            emit(bridge.preview_packet(args.request))
        elif args.operation == 'menu':
            result = bridge.human()
            emit(result)
            if isinstance(result, dict) and result.get('next_action') == 'human_chromium_download_approval':
                raise SystemExit(15)
        else:
            request = bridge.request(args.request)
            digest = m.payload_digest(request)
            if args.mode == 'live' and args.checked_digest != digest:
                raise ValueError('request changed after offline preflight')
            if args.mode == 'check':
                normalized = bridge.normalize(args.operation, request)
                emit({'live': bridge.live_grant(args.operation, normalized), 'digest': digest,
                      'facebook_collection': is_facebook_collection(args.operation, normalized)})
            else:
                emit(bridge.call(args.operation, request, run=args.run, online=args.mode == 'live'))


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt):
        emit({'status': 'stopped', 'notice': '安全に処理を続けられませんでした。自動再送せず、保存済みの状態を確認してください。'})
        sys.exit(2)

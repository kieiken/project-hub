"""Only new Stage 2 and credential-intake boundaries. No live service or private root."""
from datetime import datetime, timedelta, timezone
import contextlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('stage_one_helpers', HERE / 'muse-hub-bridge.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
bridge, app, m, safety = base.bridge, base.app, base.m, base.safety
sys.path.insert(0, str(HERE.parent / 'lib/muse'))
import extras
import hub_mcp
from metamuse import remote_media
from metamuse.config import RemoteApproval


class PageGateway:
    backend = 'fixture'
    def __init__(self):
        self.sent, self.reads, self.read_error = [], [], False
    def identity(self):
        return '123456'
    def send(self, page, message):
        self.sent.append((page, message))
        return page + '_98765'
    def read(self, remote_id):
        self.reads.append(remote_id)
        if self.read_error:
            raise m.CoreError(m.ErrorCode.NETWORK_TIMEOUT, 'Synthetic read timeout')
        return {'id': remote_id, 'from': {'id': '123456'}, 'message': self.sent[0][1], 'is_published': True}


class StageTwo(unittest.TestCase):
    setUp = base.Journey.setUp
    new_bridge = base.Journey.new_bridge
    call = base.Journey.call
    packet = base.Journey.packet
    human_answers = base.Journey.human_answers

    def grant(self, operation, request, key='fixture-grant', expired=False):
        self.b.ctx.non_interactive = False
        with self.b.review_policy(operation == 'collect.remote'):
            preview = safety.approval_preview(self.b.ctx, operation, request)
            permit = safety.approve_permit(self.b.ctx, preview, expires_at=(datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(), request_key=key)
        self.b.ctx.non_interactive = True
        self.assertEqual(permit.status, 'ok', permit)
        return permit.data['id']

    def publication(self):
        config = bridge.load_config(self.b.ctx.paths.root)
        config.publishing.enabled, config.publishing.backend = True, 'fixture'
        config.publishing.account, config.publishing.page_id, config.publishing.api_version = 'synthetic-page', '123456', 'v25.0'
        self.b.write_config(config)
        gateway = PageGateway()
        self.b.ctx.publishing_gateway = gateway
        draft = self.call('draft_save', {'text': 'Synthetic public draft', 'platform': 'facebook', 'request_key': 'draft'}).data
        return {'project_id': self.b.project_id, 'draft_id': draft['draft_id'], 'revision': 1,
                'account': 'synthetic-page', 'destination': '123456', 'request_key': 'send'}, gateway

    def test_credentials_never_enter_collect_search_packet(self):
        with self.b.open():
            values = [(self.taskroot / 'credential-intake/ordinary.txt', b'SYNTHETIC_PRIVATE_MARKER'),
                      (self.taskroot / 'inputs/page-token.txt', b'SYNTHETIC_PRIVATE_MARKER'),
                      (self.taskroot / 'inputs/ordinary.json', b'{"cookies":[{"name":"xs","value":"SYNTHETIC_PRIVATE_MARKER"}]}'),
                      (self.project / 'storage-state.json', b'SYNTHETIC_PRIVATE_MARKER')]
            for path, raw in values:
                path.write_bytes(raw); path.chmod(0o600)
                with self.assertRaises(ValueError):
                    self.call('collect', {'inputs': [{'kind': 'local_file', 'path': str(path), 'format': 'text'}],
                        'resources': ['post'], 'limits': {'max_urls': 1, 'max_items': 2, 'max_bytes': 10000, 'wall_clock_seconds': 30},
                        'access_grant_id': None, 'request_key': 'forbidden-' + path.name})
                self.assertNotIn(str(self.taskroot / 'credential-intake'), self.b.ctx.policy.app.import_roots)
            found = self.call('search', {'query': 'SYNTHETIC_PRIVATE_MARKER'})
            self.assertEqual(found.data['results'], [])
            packet = self.b.call('metamuse_packet_prepare', {'selection': [{'kind': 'item_revision', 'id': 'itm_' + '0'*32, 'revision': 1}], 'request_key': 'forged'})
            self.assertNotEqual(packet.status, 'ok')
            for path, _ in values[1:]:
                answers = iter(['8', 'publishing', 'fixture-page', str(path)])
                with patch.object(sys.stdin, 'isatty', return_value=True), patch.object(sys.stdout, 'isatty', return_value=True), patch.object(sys.stderr, 'isatty', return_value=True):
                    with self.assertRaises(ValueError):
                        self.b.human(lambda _: next(answers))
            self.assertEqual((self.taskroot / 'credential-intake').stat().st_mode & 0o777, 0o700)

    def test_publication_preview_exact_approval_once_and_cached_get(self):
        with self.b.open():
            request, gateway = self.publication()
            preview = self.call('publication_preview', {k: v for k, v in request.items() if k != 'request_key'})
            self.assertIn('Synthetic public draft', json.dumps(preview.model_dump(mode='json')))
            refused = self.b.call('metamuse_publication_submit', request, run=True)
            self.assertEqual(refused.error.code, m.ErrorCode.SCOPE_REQUIRED)
            self.assertEqual(gateway.sent, [])
            approval = {'operation': 'publication.send', 'request': request,
                'expires_at': (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
                'request_key': 'human-fixture-post', 'max_uses': 1}
            path = self.inputs / 'approve-post.json'; path.write_text(json.dumps(approval))
            lines, text = self.human_answers(['2', str(path), 'wrong digest'])
            self.assertTrue(lines[-1]['cancelled'])
            self.assertIn('Synthetic public draft', text)
            lines, text = self.human_answers(['2', str(path), lines[0]['approval']['action_digest']])
            request['publication_grant'] = lines[-1]['data']['id']
            sent = self.call('publication_submit', request, True)
            self.assertEqual(sent.data['job']['state'], 'succeeded', sent)
            publication_id = sent.data['publication_id']
            saved = self.call('publication_get', {'publication_id': publication_id})
            self.assertEqual(saved.data['state'], 'sent_verified')
            with self.assertRaises(ValueError):
                self.call('publication_submit', {**request, 'request_key': 'new-key'}, True)
            self.assertEqual(len(gateway.sent), 1)
            self.assertFalse(saved.data['live_verified'])

    def test_unknown_delivery_restart_reconcile_only(self):
        with self.b.open():
            request, gateway = self.publication()
            request['publication_grant'] = self.grant('publication.send', request)
            gateway.read_error = True
            sent = self.call('publication_submit', request, True)
            publication_id = sent.data['publication_id']
            state = self.call('publication_get', {'publication_id': publication_id}).data
            self.assertEqual(state['state'], 'needs_reconcile')
            self.assertEqual(len(gateway.sent), 1)
            with self.assertRaises(ValueError):
                self.call('job_control', {'job_id': state['job_id'], 'operation': 'resume', 'request_key': 'remote-resume'})
        self.b = self.new_bridge()
        with self.b.open():
            self.b.ctx.publishing_gateway = gateway
            blocked = self.b.call('metamuse_publication_submit', {**request, 'publication_grant': None, 'request_key': 'no-resend'})
            self.assertEqual(blocked.error.code, m.ErrorCode.EXTERNAL_STATE_UNKNOWN)
            reconcile = {'publication_id': publication_id, 'request_key': 'reconcile'}
            reconcile['publication_grant'] = self.grant('publication.reconcile', reconcile, 'fixture-read-grant')
            gateway.read_error = False
            final = self.call('publication_reconcile', reconcile, True)
            self.assertEqual(final.data['job']['state'], 'succeeded', final)
            self.assertEqual(self.call('publication_get', {'publication_id': publication_id}).data['state'], 'sent_verified')
            self.assertEqual(len(gateway.sent), 1)

    def test_publication_unknown_without_receipt_never_resends(self):
        with self.b.open():
            request, gateway = self.publication()
            request['publication_grant'] = self.grant('publication.send', request)
            original = gateway.send
            def unknown(page, message):
                original(page, message)
                raise m.CoreError(m.ErrorCode.NETWORK_TIMEOUT, 'Synthetic unknown submission')
            gateway.send = unknown
            sent = self.call('publication_submit', request, True)
            publication_id = sent.data['publication_id']
            saved = self.call('publication_get', {'publication_id': publication_id}).data
            self.assertIsNone(saved['remote_id'])
            for key in ('same-payload', 'different-key'):
                refused = self.b.call('metamuse_publication_submit', {**request, 'publication_grant': None, 'request_key': key})
                self.assertEqual(refused.error.code, m.ErrorCode.EXTERNAL_STATE_UNKNOWN)
            reconcile = self.b.call('metamuse_publication_reconcile', {'publication_id': publication_id, 'request_key': 'no-receipt'})
            self.assertEqual(reconcile.status, 'error')
            self.assertEqual(len(gateway.sent), 1)

    def test_changed_publication_target_and_expired_grant_refused(self):
        with self.b.open():
            request, gateway = self.publication()
            request['publication_grant'] = self.grant('publication.send', request)
            changed = self.b.call('metamuse_publication_submit', {**request, 'destination': '654321'}, run=True)
            self.assertNotIn(changed.status, ('accepted', 'ok'))
            with patch.object(bridge, 'datetime', wraps=datetime) as clock:
                clock.now.return_value = datetime.now(timezone.utc) + timedelta(hours=1)
                with self.assertRaises(ValueError): self.b.live_grant('metamuse_publication_submit', request)
            self.b.ctx.non_interactive = False
            safety.revoke_permit(self.b.ctx, request['publication_grant'], request_key='fixture-revoke')
            self.b.ctx.non_interactive = True
            with self.assertRaises(ValueError):
                self.call('publication_submit', request, True)
            self.assertEqual(gateway.sent, [])

    def remote_fixtures(self):
        class Extractor:
            @classmethod
            def ie_key(cls): return 'Synthetic'
        return contextlib.ExitStack(), Extractor

    def test_url_approval_grant_collection_and_search(self):
        with self.b.open():
            config = bridge.load_config(self.b.ctx.paths.root)
            config.remote_media.approvals = [RemoteApproval(extractor='Synthetic', hosts=['media.fixture.test'])]
            self.b.write_config(config)
            request = {'project_id': self.b.project_id, 'inputs': [{'kind': 'url', 'url': 'https://media.fixture.test/video'}],
                       'resources': ['media_metadata'], 'limits': {'max_urls': 1, 'max_items': 2, 'max_bytes': 10000, 'wall_clock_seconds': 30}, 'access_grant_id': None, 'request_key': 'url-import'}
            stack, extractor = self.remote_fixtures()
            record = {'title': 'Synthetic remote video title', 'platform': 'synthetic', 'scope': 'synthetic', 'native_id': 'video',
                      'extractor': 'Synthetic', 'canonical_url': 'https://media.fixture.test/video', 'canonical_basis': 'extractor',
                      'raw_time': None, 'subtitles': {}, 'subtitles_truncated': False, 'media_url': None, 'media_ext': None}
            with stack:
                stack.enter_context(patch.object(remote_media, 'dependency_available', return_value=True))
                stack.enter_context(patch.object(remote_media, '_require_reviewable_url', side_effect=lambda url: url))
                stack.enter_context(patch.object(remote_media, '_select', side_effect=lambda url, approvals: (extractor, approvals[0])))
                stack.enter_context(patch.object(remote_media, '_extractor_class', return_value=extractor))
                stack.enter_context(patch.object(remote_media, '_read_info', return_value=record))
                stack.enter_context(patch.object(remote_media, '_open_ydl', return_value=SimpleNamespace(close=lambda: None)))
                refused = self.b.call('metamuse_collect', request)
                self.assertEqual(refused.error.code, m.ErrorCode.SCOPE_REQUIRED, refused)
                request['access_grant_id'] = self.grant('collect.remote', request)
                result = self.call('collect', request, True)
                self.assertEqual(result.data['job']['state'], 'succeeded', result)
                found = self.call('search', {'query': 'remote video'})
                self.assertTrue(found.data['results'])
                self.assertEqual(self.b.ctx.policy.app.network_mode, 'offline')
                with self.assertRaises(ValueError):
                    self.call('collect', {**request, 'request_key': 'duplicate'}, True)

    def test_remote_missing_dependencies_and_private_url_stop(self):
        with self.b.open():
            request = {'inputs': [{'kind': 'url', 'url': 'https://127.0.0.1/private'}], 'resources': ['media_metadata'],
                'limits': {'max_urls': 1, 'max_items': 2, 'max_bytes': 10000, 'wall_clock_seconds': 30}, 'access_grant_id': None, 'request_key': 'private-url'}
            result = self.b.call('metamuse_collect', request)
            self.assertEqual(result.status, 'error')
            self.assertEqual(self.b.ctx.policy.app.network_mode, 'offline')
            with self.assertRaises(RuntimeError):
                with self.b.review_policy(True):
                    self.assertEqual(bridge.load_config(self.b.ctx.paths.root).app.network_mode, 'live')
                    raise RuntimeError('synthetic interruption')
            self.assertEqual(bridge.load_config(self.b.ctx.paths.root).app.network_mode, 'offline')

    def test_facebook_post_comments_fixture_and_readiness(self):
        from metamuse import facebook
        url = 'https://www.facebook.com/synth.lab/posts/pfbid0101synth'
        markup = ('<!DOCTYPE html><html><head></head><body><article role="article" data-fb-role="post" '
            'data-post-id="pfbid0101synth" data-actor="synth.lab" data-author="Synthetic" '
            'data-permalink="' + url + '" data-comments-exhausted="true" data-comment-count="1">'
            '<div data-fb-role="post-body">Synthetic Facebook announcement</div></article>'
            '<section data-fb-role="comments-section"><article role="article" data-fb-role="comment" '
            'data-comment-id="101" data-author="Synthetic reader"><div data-fb-role="comment-body">'
            'Synthetic Facebook comment</div></article></section></body></html>')
        driver = facebook.FixtureBrowserDriver(facebook.PageObservation(url=url, status_code=200, html=markup))
        facebook.set_driver_factory(lambda: driver)
        facebook.set_resolver_factory(lambda: lambda _: ['93.184.216.34'])
        self.addCleanup(lambda: facebook.set_driver_factory(None))
        self.addCleanup(lambda: facebook.set_resolver_factory(None))
        with self.b.open():
            secret = self.b.ctx.secret_store.put(json.dumps({'cookies': [
                {'name': 'c_user', 'value': '1099', 'domain': '.facebook.com', 'path': '/', 'httpOnly': False, 'secure': True},
                {'name': 'xs', 'value': 'SYNTHETIC_COOKIE', 'domain': '.facebook.com', 'path': '/', 'httpOnly': True, 'secure': True}],
                'origins': []}).encode(), provider='facebook', account='fixture', created_at=self.b.ctx.clock())
            config = bridge.load_config(self.b.ctx.paths.root)
            config.facebook.enabled, config.facebook.account, config.facebook.auth_ref = True, 'fixture', secret['auth_ref']
            config.facebook.approved_page_types = ['post_permalink']
            config.facebook.pacing_ms = 0
            self.b.write_config(config)
            request = {'project_id': self.b.project_id, 'inputs': [{'kind': 'url', 'url': url}], 'resources': ['post', 'comments'],
                'limits': {'max_urls': 1, 'max_items': 5, 'max_bytes': 100000, 'wall_clock_seconds': 30},
                'access_grant_id': None, 'request_key': 'facebook-fixture'}
            refused = self.b.call('metamuse_collect', request)
            self.assertEqual(refused.error.code, m.ErrorCode.SCOPE_REQUIRED, refused)
            self.assertEqual(driver.visited_urls, [])
            request['access_grant_id'] = self.grant('collect.remote', request)
            result = self.call('collect', request, True)
            self.assertEqual(result.data['job']['state'], 'succeeded', result)
            found = self.call('search', {'query': 'Synthetic Facebook'})
            self.assertEqual(len(found.data['results']), 2, found)
            self.assertEqual(driver.visited_urls, [url])
            self.assertTrue(driver.closed)
            self.assertNotIn('SYNTHETIC_COOKIE', json.dumps(found.model_dump(mode='json')))
            status = bridge.external_component_status()
            self.assertTrue(status['facebook_blockers'])
            self.assertIsNone(status['chromium']['sha256'])

    def test_mcp_has_19_tools_no_approval_and_scoped_dispatch(self):
        tools = hub_mcp.upstream_mcp.list_tools()
        self.assertEqual(len(tools), 19)
        self.assertEqual(set(x.name for x in tools), set(m.TOOL_REQUEST_MODELS))
        self.assertFalse(any('permit' in x.name or 'auth' in x.name for x in tools))
        dispatch = hub_mcp.Dispatcher(HERE.parent / 'lib/muse/hub_launcher.py', self.inputs.parent, 'Synthetic', 'task', self.taskroot)
        self.assertEqual(dispatch.call('permit_approve', {})['status'], 'stopped')
        with patch.object(subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'{"status":"ok","data":{"synthetic":true}}')) as run:
            value = dispatch.call('metamuse_search', {'query': 'fixture'})
            self.assertEqual(value['status'], 'ok')
            command = run.call_args.args[0]
            self.assertEqual(command[command.index('--task') + 1], 'task')
            self.assertIn('--run', command)
            self.assertEqual(Path(command[-1]).stat().st_mode & 0o777, 0o600)
            dispatch.lock.acquire()
            self.assertEqual(dispatch.call('metamuse_search', {'query': 'busy'})['status'], 'stopped')
            dispatch.lock.release()
        with patch.object(subprocess, 'run', side_effect=subprocess.TimeoutExpired('synthetic', 1)) as run:
            self.assertEqual(dispatch.call('metamuse_search', {'query': 'unknown'})['status'], 'stopped')
            self.assertEqual(run.call_count, 1)

    def test_mcp_stdio_protocol_fixture(self):
        import selectors
        process = subprocess.Popen([sys.executable, '-B', __file__, '--fixture-mcp'], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        def exchange(value, response=True):
            process.stdin.write(json.dumps(value) + '\n'); process.stdin.flush()
            if response:
                selector = selectors.DefaultSelector(); selector.register(process.stdout, selectors.EVENT_READ)
                try:
                    self.assertTrue(selector.select(10), 'MCP response timeout')
                    return json.loads(process.stdout.readline())
                finally:
                    selector.close()
        initialized = exchange({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'synthetic-test', 'version': '1'}}})
        self.assertEqual(initialized['result']['serverInfo']['name'], 'metamuse-hub')
        exchange({'jsonrpc': '2.0', 'method': 'notifications/initialized'}, False)
        listing = exchange({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'})
        self.assertEqual(len(listing['result']['tools']), 19)
        result = exchange({'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'metamuse_inspect', 'arguments': {}}})
        self.assertTrue(json.loads(result['result']['content'][0]['text'])['fixture'])
        process.stdin.close(); process.wait(timeout=10)
        self.assertEqual(process.returncode, 0, process.stderr.read())
        process.stdout.close(); process.stderr.close()

    def test_extras_offline_synthetic_install_and_tree_tamper(self):
        import hashlib
        raw = b'synthetic-wheel-not-a-package'
        row = {'name': 'yt-dlp', 'version': '2026.8.19', 'filename': 'fixture.whl',
               'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        staged = self.taskroot / 'extras-wheels'; staged.mkdir(parents=True, mode=0o700)
        wheel = staged / row['filename']; wheel.write_bytes(raw); wheel.chmod(0o600)
        def make_environment(target):
            site = target / 'lib/python3.12/site-packages'
            site.mkdir(parents=True, mode=0o700)
            (target / 'bin').mkdir(mode=0o700)
            fixed = self.inputs.parent / '.venv/bin/python'
            fixed.parent.mkdir(parents=True, mode=0o700)
            fixed.write_bytes(b'fixture-interpreter-not-executed')
            (target / 'bin/python').symlink_to(fixed)
            (target / 'pyvenv.cfg').write_text('fixture = true')
            (site / 'synthetic.py').write_text('synthetic = True')
        digest = hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest()
        with patch.object(extras, 'manifest', return_value={'wheels': [row]}), patch.object(extras.venv.EnvBuilder, 'create', side_effect=make_environment), patch.object(subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run, patch.object(sys.stdin, 'isatty', return_value=True), patch.object(sys.stdout, 'isatty', return_value=True), patch.object(sys.stderr, 'isatty', return_value=True):
            result = extras.install_video(self.inputs.parent, self.taskroot, lambda _: digest)
            self.assertEqual(result['network'], 'offline')
            self.assertIn('--no-index', run.call_args.args[0])
            self.assertIn('--require-hashes', run.call_args.args[0])
            self.assertEqual(extras.interpreter(self.inputs.parent, self.taskroot), self.taskroot / 'extras-venv/bin/python')
            with self.assertRaises(ValueError): extras.install_video(self.inputs.parent, self.taskroot, lambda _: digest)
        changed = self.taskroot / 'extras-venv/lib/python3.12/site-packages/synthetic.py'
        changed.write_text('changed = True')
        with self.assertRaises(ValueError): extras.interpreter(self.inputs.parent, self.taskroot)

    def test_extras_owner_menu_preserves_partial_without_installing(self):
        with self.b.open():
            fixed = self.inputs.parent / '.venv/bin/python'
            fixed.parent.mkdir(parents=True)
            fixed.symlink_to(Path(sys._base_executable).resolve())
            target = self.taskroot / 'extras-venv'
            extras.venv.EnvBuilder(with_pip=False, symlinks=False).create(target)
            target.chmod(0o700)
            before = extras._tree(target)
            out = __import__('io').StringIO()
            answers = 0
            def reader(_):
                nonlocal answers
                answers += 1
                return '16' if answers == 1 else out.getvalue().split('確認番号: ')[-1].strip()
            with contextlib.redirect_stdout(out), \
                    patch.object(sys.stdin, 'isatty', return_value=True), \
                    patch.object(sys.stdout, 'isatty', return_value=True), \
                    patch.object(sys.stderr, 'isatty', return_value=True):
                result = self.b.human(reader)
            self.assertEqual(answers, 2)
            self.assertEqual(extras._tree(Path(result['preserved'])), before)
            self.assertFalse(result['installed'])
            self.assertFalse(target.exists())

    def test_extras_hash_size_and_no_unapproved_install(self):
        rows = extras.manifest()['wheels']
        self.assertEqual(next(x for x in rows if x['name'] == 'playwright')['version'], '1.63.0')
        self.assertEqual(next(x for x in rows if x['name'] == 'yt-dlp')['version'], '2026.8.19')
        self.assertFalse(extras.manifest()['installed'])
        self.assertIsNone(extras.manifest()['chromium']['sha256'])
        path = self.inputs / 'fixture.whl'; path.write_bytes(b'synthetic wheel'); path.chmod(0o600)
        import hashlib
        row = {'filename': path.name, 'bytes': len(path.read_bytes()), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        self.assertEqual(extras.validate_wheel(path, row), path)
        with self.assertRaises(ValueError): extras.validate_wheel(path, {**row, 'sha256': '0'*64})
        with self.assertRaises(ValueError): extras.validate_wheel(path, {**row, 'bytes': 1})
        with self.assertRaises(ValueError): extras.install_video(self.inputs.parent, self.taskroot)
        self.assertFalse((self.taskroot / 'extras-venv').exists())


if __name__ == '__main__':
    if sys.argv[1:] == ['--fixture-mcp']:
        import asyncio
        class FixtureDispatch:
            def call(self, tool, arguments):
                return {'status': 'ok', 'fixture': True, 'tool': tool}
        asyncio.run(hub_mcp.serve(FixtureDispatch()))
    else:
        unittest.main(verbosity=2)

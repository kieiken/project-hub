"""Read subscription metadata for ONE existing binding, only on a human request.

Discovery/parsing adapted from CodexBar museai.js at
d34fbb47afe73f81dd591bae28a60f72c39a9fe4 (no browser/account discovery).
MIT License
Copyright (c) 2026 Peter Steinberger

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import time

from metamuse import safety
from metamuse.config import load_config
from metamuse._muse_adapters import BoundMuseCredentials, resolve_all
from metamuse import _muse_http as http

ORIGIN = 'https://muse.ai'
MAX_BYTES = 8 * 1024 * 1024
ACTION = re.compile(r'[0-9a-f]{40,128}')
CHUNKS = re.compile(r'static/chunks/[\w~.-]+\.js', re.ASCII)
USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
ERRORS = {'auth', 'site_changed', 'network', 'format', 'unconfigured', 'busy'}


class UsageError(Exception):
    def __init__(self, code):
        self.code = code if code in ERRORS else 'format'
        super().__init__(self.code)


class UsageHttp:
    """Upstream TLS/DNS/proxy/redirect controls, with a bounded chunk-sized buffer.

    CurlHttp's 64KiB auth-body cap cannot hold website JS chunks. Reuse its
    transport components without changing that cap for any existing operation.
    No cookie jar, redirects, retries, body logging or arbitrary URLs.
    """
    def request(self, method, url, *, headers, body, checked, timeout, limit):
        session_type, _, curl_opt = http.load_curl()
        bundle = http._ca_bundle()
        writer = http.AuthBodyBuffer(limit)
        try:
            with session_type(impersonate='chrome', verify=bundle, trust_env=False,
                              allow_redirects=False, curl_options=http._options(curl_opt, checked)) as session:
                response = session.request(method, url, headers=headers, data=body,
                    impersonate='chrome', verify=bundle, allow_redirects=False,
                    timeout=timeout, content_callback=writer)
                if writer.overflow:
                    raise UsageError('site_changed')
                return http.HttpResponse(int(response.status_code), bytes(writer.data),
                    {str(k).lower(): str(v) for k, v in response.headers.items()},
                    http._peer_text(response.primary_ip))
        except UsageError:
            raise
        except Exception:
            raise UsageError('site_changed' if writer.overflow else 'network') from None


def number(value):
    return type(value) in (float, int) and math.isfinite(value)


def label(value):
    # Never forward arbitrary server strings or credential-shaped text.
    if not isinstance(value, str) or not 0 < len(value) <= 96:
        return None
    if not re.fullmatch(r'[\w .,%$()+/\-]+', value) or re.search(r'[A-Za-z0-9_\-]{32,}', value):
        return None
    return value if safety.redact_display(value) == value else None


def seconds(value):
    if not number(value) or not 0 < value < 253402300799:
        return None
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def tokens(value):
    if not isinstance(value, str):
        return None
    match = re.search(r'\(([0-9][0-9.,]*\s*[KMBTkmbt]? tokens left)\)', value)
    return label(match[1]) if match else None


def project_response(raw):
    sub = None
    try:
        for line in raw.decode('utf-8').splitlines():
            match = re.fullmatch(r'[0-9a-f]+:(\{.*\})\s*', line)
            if not match:
                continue
            try:
                row = json.loads(match[1])
            except ValueError:
                continue
            if row.get('success') is True:
                sub = row.get('subscription')
        if not isinstance(sub, dict) or not isinstance(sub.get('usage'), dict):
            raise UsageError('format')
        usage = sub['usage']
        if not number(usage.get('percentUsed')):
            raise UsageError('format')
        tier, agreement = sub.get('tier'), sub.get('agreement')
        plan = label(tier.get('name')) if isinstance(tier, dict) else None
        plan = plan or label(sub.get('usageRowLabel'))
        topup = None
        balance, total = sub.get('topupBalance'), sub.get('topupTotal')
        if number(balance) and number(total) and 0 <= balance <= total and total > 0:
            topup = {'label': label(sub.get('topupRowLabel')) or 'Additional tokens',
                     'value': tokens(sub.get('topupRowValueLabel')) or
                              label(sub.get('topupRowValueLabel')) or f'${balance / 1e6:,.2f} left'}
        return {'plan': plan, 'usedPercent': max(0, min(100, usage['percentUsed'])),
                'resetsAt': seconds(usage.get('resetsAt')),
                'tokensLeftLabel': tokens(sub.get('usageRowValueLabel')) if plan and plan.lower() != 'free' else None,
                'renewsAt': seconds(agreement.get('currentPeriodEndTime')) if isinstance(agreement, dict) else None,
                'topup': topup, 'checkedAt': datetime.now(timezone.utc).isoformat()}
    except UsageError:
        raise
    except Exception:
        raise UsageError('format') from None


class UsageReader:
    def __init__(self, cookie, client=None, resolver=resolve_all):
        self.cookie = cookie
        self.client = client or UsageHttp()
        self.policy = safety.OutboundURLPolicy(resolver, ('muse.ai',))
        self.remaining = MAX_BYTES
        self.deadline = time.monotonic() + 60

    def fetch(self, path, action=None):
        static = bool(re.fullmatch(r'/_next/static/chunks/[\w~.-]+\.js', path, re.ASCII))
        if path != '/' and not static or static and action is not None:
            raise UsageError('site_changed')
        if self.remaining <= 0 or time.monotonic() >= self.deadline:
            raise UsageError('site_changed')
        headers = {'Accept': '*/*' if static else 'text/html', 'User-Agent': USER_AGENT}
        if not static:
            headers['Cookie'] = self.cookie
        if action is not None:
            if not ACTION.fullmatch(action):
                raise UsageError('site_changed')
            headers.update({'Accept': 'text/x-component', 'Next-Action': action, 'Origin': ORIGIN,
                'Content-Type': 'text/plain;charset=UTF-8', 'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'})
        url = ORIGIN + path
        try:
            checked = self.policy.before_request(url)
            response = self.client.request('POST' if action else 'GET', url, headers=headers,
                body=b'[{"includeAgreement":true}]' if action else None, checked=checked,
                timeout=min(10, max(.1, self.deadline - time.monotonic())),
                limit=min(2 * 1024 * 1024, self.remaining))
            safety.OutboundURLPolicy(lambda host: checked.addresses if host == 'muse.ai' else (),
                ('muse.ai',)).before_request(url, peer_address=response.peer)
        except UsageError:
            raise
        except Exception:
            raise UsageError('network') from None
        self.remaining -= len(response.body)
        if self.remaining < 0 or len(response.body) > 2 * 1024 * 1024:
            raise UsageError('site_changed')
        location = {k.lower(): v for k, v in response.headers.items()}.get('location', '')
        if response.status in (401, 403) or location.startswith('https://auth.muse.ai/'):
            raise UsageError('auth')
        if response.status != 200 and not (action and self.stale(response)):
            raise UsageError('site_changed' if 300 <= response.status < 400 else 'network')
        return response

    @staticmethod
    def stale(response):
        return response.status == 404 and b'server action not found' in response.body.lower()

    @staticmethod
    def paths(text):
        return list(dict.fromkeys('/_next/' + p for p in CHUNKS.findall(text)))

    def discover(self):
        page = self.fetch('/').body.decode('utf-8', errors='replace')
        paths = self.paths(page)[:96]
        text = ''
        for offset in range(0, len(paths), 8):
            text += '\n'.join(self.fetch(p).body.decode('utf-8', errors='replace') for p in paths[offset:offset+8])
            module = re.search(r'\.A\((\d+)\)\.then\(\(\{[^}]*Settings', text)
            if not module:
                continue
            loader = re.search(r'[,{\[]' + module[1] + r',\w+=>\{\w+\.v\(\w+=>Promise\.all\(\[([^\]]*)', text)
            if not loader:
                continue
            for p in self.paths(loader[1])[:32]:
                body = self.fetch(p).body.decode('utf-8', errors='replace')
                match = re.search(r'"([0-9a-f]{40,128})",[^"\n]{0,200}"fetchSubscriptionAction"', body)
                if match:
                    return match[1]
            break
        raise UsageError('site_changed')

    def read(self, cached_action, clear_action):
        response = self.fetch('/', cached_action) if cached_action else None
        if response is None or self.stale(response):
            # Only a definite obsolete action triggers one bounded discovery.
            # Auth/network/format failures are never retried.
            clear_action()
            cached_action = self.discover()
            response = self.fetch('/', cached_action)
            if self.stale(response):
                raise UsageError('site_changed')
        return project_response(response.body), cached_action


def control(core, args, *, client=None, resolver=resolve_all):
    """Separate from Bridge.open: no DB/config/grants/jobs or chat modifications."""
    live = args.operation == 'usage-read'
    if args.request or args.checked_digest or args.run or args.mode != ('live' if live else 'offline'):
        raise ValueError('usage control arguments')
    legacy = Path(args.legacy)
    root = legacy / 'usage'
    # A global registration lock also excludes concurrent reads across processes.
    with core.locked(legacy / '.registration.lock', create=False):
        config_path = legacy / 'workspace-muse/metamuse.toml'
        core.checked(config_path)
        cfg = load_config(config_path.parent)
        binding = cfg.muse.binding if cfg.muse.enabled else None
        if not binding or cfg.app.network_mode != 'offline' or cfg.app.telemetry_enabled:
            return {'usage': None, 'error': 'unconfigured'}
        identity = hashlib.sha256(binding.model_dump_json().encode()).hexdigest()
        cache = root / 'usage-result.json'
        action_file = root / 'usage-action.json'

        def read_file(file):
            if not os.path.lexists(file):
                return {}
            core.checked(file)
            return json.loads(safety._read_secret_file(file, 16384))

        if not live:
            saved = read_file(cache)
            if saved.get('binding') != identity:
                return {'usage': None}
            return {'usage': saved.get('usage'), **({'error': saved['error']} if saved.get('error') in ERRORS else {})}
        core.private_dir(root)
        # No authentication bytes are read until the explicit live operation.
        try:
            cookie = BoundMuseCredentials(binding, core.ReadOnlySecrets(legacy, binding)).cookies(binding.auth_ref)
        except Exception:
            result = {'usage': None, 'error': 'auth'}
            core.save(cache, json.dumps({'binding': identity, **result}) + '\n')
            return result
        action = read_file(action_file)
        action = action.get('action') if action.get('binding') == identity else None
        if not isinstance(action, str) or not ACTION.fullmatch(action):
            action = None

        def clear():
            core.save(action_file, '{}\n')

        try:
            usage, action = UsageReader(cookie, client, resolver).read(action, clear)
            core.save(action_file, json.dumps({'binding': identity, 'action': action}) + '\n')
            result = {'usage': usage}
        except UsageError as error:
            result = {'usage': None, 'error': error.code}
        core.save(cache, json.dumps({'binding': identity, **result}) + '\n')
        return result

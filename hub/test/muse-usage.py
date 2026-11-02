"""Synthetic subscription reads; the process is network-denied by sandbox-exec."""
import importlib.util
import json
import os
import sys
import io
import contextlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1] / 'lib/muse'

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod

usage = load('usage', HERE / 'usage.py')
core = load('core', HERE / 'hub_core.py')
from metamuse import models as m
from metamuse.config import Config

ACTION, NEW = 'a' * 40, 'b' * 40
COOKIE = 'synthetic_cookie=DO_NOT_PERSIST'
IP = '93.184.216.34'
def resolve(host):
    assert host == 'muse.ai'
    return (IP,)

def response(data=None, status=200, headers=None, raw=None):
    if raw is None:
        raw = '1:' + json.dumps({'success': True, 'subscription': data or {
            'tier': {'name': 'Power'}, 'usage': {'percentUsed': 23, 'resetsAt': 1800000000},
            'usageRowValueLabel': '23% used (2.8B tokens left)',
            'agreement': {'currentPeriodEndTime': 1800000100},
            'topupBalance': 2500000, 'topupTotal': 5000000}})
    return usage.http.HttpResponse(status, raw.encode(), headers or {}, IP)

class Client:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []
    def request(self, method, url, **kw):
        self.calls.append((method, url, kw))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

class Tests(unittest.TestCase):
    def test_project_paid_free_topup_missing_and_untrusted_fields(self):
        u = usage.project_response(response().body)
        self.assertEqual((u['plan'], u['usedPercent'], u['tokensLeftLabel']), ('Power', 23, '2.8B tokens left'))
        self.assertEqual(u['topup']['value'], '$2.50 left')
        self.assertEqual(set(u), {'plan','usedPercent','tokensLeftLabel','resetsAt','renewsAt','topup','checkedAt'})
        u = usage.project_response(response({'tier':{'name':'Free'},'usage':{'percentUsed':0},'usageRowValueLabel':'(2B tokens left)'}).body)
        self.assertEqual(u['usedPercent'], 0)
        self.assertIsNone(u['tokensLeftLabel']); self.assertIsNone(u['topup']); self.assertIsNone(u['resetsAt'])
        for value in [None, True, '0', float('nan'), float('inf')]:
            with self.subTest(value=value), self.assertRaises(usage.UsageError):
                usage.project_response(response({'usage':{'percentUsed':value}}).body)
        u = usage.project_response(response({'tier':{'name':'<script>SECRET</script>'},'usage':{'percentUsed':300}}).body)
        self.assertIsNone(u['plan']); self.assertEqual(u['usedPercent'], 100)

    def discovery(self):
        return [response(raw='<script src="/_next/static/chunks/app.js">'),
                response(raw='.A(42).then(({preloadHatchSettingsData})=>{});[42,e=>{e.v(e=>Promise.all(["static/chunks/settings.js"]'),
                response(raw='"' + NEW + '",e.call,e,"fetchSubscriptionAction"'), response()]

    def test_stale_action_discovers_once_same_origin_cookie_only_on_page_and_post(self):
        c = Client([response(status=404, raw='Server action not found')] + self.discovery())
        cleared = []
        u, action = usage.UsageReader(COOKIE,c,resolve).read(ACTION,lambda:cleared.append(1))
        self.assertEqual(action,NEW); self.assertEqual(cleared,[1]); self.assertEqual(u['usedPercent'],23)
        self.assertEqual(len(c.calls),5)
        for method,url,kw in c.calls:
            self.assertTrue(url.startswith('https://muse.ai/'))
            self.assertEqual(kw['checked'].addresses,(IP,))
            if '/_next/' in url:
                self.assertNotIn('Cookie',kw['headers']); self.assertEqual(method,'GET')
            else:
                self.assertEqual(kw['headers']['Cookie'],COOKIE)
            if method=='POST':
                self.assertEqual(kw['body'],b'[{"includeAgreement":true}]')
                self.assertEqual(kw['headers']['Sec-Fetch-Site'],'same-origin')

    def test_failures_never_retry_or_echo_body(self):
        for reply,code in [(response(status=403),'auth'),
                           (response(status=302,headers={'Location':'https://auth.muse.ai/login'}),'auth'),
                           (response(status=302,headers={'location':'https://evil.invalid/'}),'site_changed'),
                           (RuntimeError(COOKIE),'network'),(response(raw=COOKIE),'format')]:
            c=Client([reply])
            with self.subTest(code=code), self.assertRaises(usage.UsageError) as e:
                usage.UsageReader(COOKIE,c,resolve).read(ACTION,lambda:None)
            self.assertEqual(str(e.exception),code); self.assertEqual(len(c.calls),1)
        c=Client([response(raw='no chunks')])
        with self.assertRaisesRegex(usage.UsageError,'site_changed'):
            usage.UsageReader(COOKIE,c,resolve).read(None,lambda:None)
        self.assertEqual(len(c.calls),1)
        c=Client(self.discovery()[:-1]+[response(status=404,raw='Server action not found')])
        with self.assertRaisesRegex(usage.UsageError,'site_changed'):
            usage.UsageReader(COOKIE,c,resolve).read(None,lambda:None)
        self.assertEqual(len(c.calls),4)

    def test_bounds_dns_peer_and_static_urls_are_enforced(self):
        c=Client([response(raw='x'*(2*1024*1024+1))])
        with self.assertRaisesRegex(usage.UsageError,'site_changed'):
            usage.UsageReader(COOKIE,c,resolve).read(ACTION,lambda:None)
        c=Client([response()]);reader=usage.UsageReader(COOKIE,c,resolve);reader.remaining=1
        with self.assertRaisesRegex(usage.UsageError,'site_changed'):
            reader.read(ACTION,lambda:None)
        for path in ['https://evil.invalid/','/api/session','/_next/static/chunks/../a.js','/_next/static/chunks/a.js?secret']:
            c=Client([])
            with self.assertRaises(usage.UsageError):
                usage.UsageReader(COOKIE,c,resolve).fetch(path)
            self.assertEqual(c.calls,[])
        c=Client([response()])
        with self.assertRaisesRegex(usage.UsageError,'network'):
            usage.UsageReader(COOKIE,c,lambda h:('127.0.0.1',)).read(ACTION,lambda:None)
        self.assertEqual(len(c.calls),0)
        c=Client([usage.http.HttpResponse(200,response().body,{},'1.1.1.1')])
        with self.assertRaisesRegex(usage.UsageError,'network'):
            usage.UsageReader(COOKIE,c,resolve).read(ACTION,lambda:None)
        c=Client([]);reader=usage.UsageReader(COOKIE,c,resolve);reader.deadline=0
        with self.assertRaisesRegex(usage.UsageError,'site_changed'):reader.discover()
        # 96 page chunks maximum, with no loader: no extra requests.
        c=Client([response(raw=' '.join('static/chunks/c%d.js'%i for i in range(100)))]+[response(raw='')]*96)
        with self.assertRaisesRegex(usage.UsageError,'site_changed'):
            usage.UsageReader(COOKIE,c,resolve).discover()
        self.assertEqual(len(c.calls),97)

    def test_transport_reuses_upstream_tls_pin_and_caps_without_redirect_proxy_or_cookie_jar(self):
        from types import SimpleNamespace as NS
        calls=[]
        class Options:
            PROXY='proxy'; CAINFO='ca'; SSL_VERIFYPEER='peer'; SSL_VERIFYHOST='host'; RESOLVE='resolve'
        class Session:
            def __init__(self,**kw):calls.append(kw)
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def request(self,*a,**kw):
                calls.append((a,kw));kw['content_callback'](b'bounded')
                return NS(status_code=200,headers={},primary_ip=IP)
        checked=usage.safety.OutboundURLPolicy(resolve,('muse.ai',)).before_request('https://muse.ai/')
        with patch.object(usage.http,'load_curl',return_value=(Session,None,Options)),patch.object(usage.http,'_ca_bundle',return_value='/synthetic/ca'):
            self.assertEqual(usage.UsageHttp().request('GET','https://muse.ai/',headers={},body=None,checked=checked,timeout=1,limit=8).body,b'bounded')
            with self.assertRaisesRegex(usage.UsageError,'site_changed'):
                usage.UsageHttp().request('GET','https://muse.ai/',headers={},body=None,checked=checked,timeout=1,limit=1)
        self.assertFalse(calls[0]['trust_env']); self.assertFalse(calls[0]['allow_redirects'])
        self.assertEqual(calls[0]['curl_options'],{'proxy':b'','ca':'/synthetic/ca','peer':1,'host':2,'resolve':['muse.ai:443:'+IP]})

    def test_control_real_bound_secret_lock_cache_permissions_and_no_workspace_or_grants(self):
        with tempfile.TemporaryDirectory(prefix='hub-usage-',dir='/private/tmp') as td:
            root=Path(td);legacy=root/'legacy';legacy.mkdir(mode=0o700)
            (legacy/'.registration.lock').write_text('');os.chmod(legacy/'.registration.lock',0o600)
            workspace=legacy/'workspace-muse';workspace.mkdir(mode=0o700)
            store=usage.safety.SecretStore(legacy/'auth')
            # Upstream encrypted/metadata conventions are exercised with synthetic bytes.
            info=store.put(provider='muse',account='synthetic',secret=json.dumps({'format':'cookie-header','cookie_header':COOKIE}).encode(),created_at='2026-10-26T00:00:00Z')
            cfg=Config();cfg.app.network_mode='offline';cfg.app.telemetry_enabled=False
            cfg.muse.enabled=True;cfg.muse.backend='live'
            cfg.muse.binding=m.MuseBinding(provider='muse',account='synthetic',auth_ref=info['auth_ref'])
            # Use Bridge's actual TOML serialization through a temporary bridge context.
            import tomlkit
            (workspace/'metamuse.toml').write_text(tomlkit.dumps(cfg.model_dump(mode='json',exclude_none=True)))
            accountroot=legacy/'usage'
            args=SimpleNamespace(legacy=str(legacy),operation='usage-status',request=None,checked_digest=None,run=False,mode='offline')
            c=Client([])
            self.assertEqual(usage.control(core,args,client=c,resolver=resolve),{'usage':None})
            self.assertFalse(accountroot.exists());self.assertEqual(c.calls,[])
            args.operation='usage-read';args.mode='live';c=Client(self.discovery())
            before=(workspace/'metamuse.toml').read_bytes()
            result=usage.control(core,args,client=c,resolver=resolve)
            self.assertEqual(result['usage']['usedPercent'],23)
            self.assertEqual((workspace/'metamuse.toml').read_bytes(),before)
            self.assertFalse((legacy/'projects').exists())
            self.assertEqual(accountroot.stat().st_mode&0o777,0o700)
            for p in accountroot.iterdir():
                self.assertEqual(p.stat().st_mode&0o777,0o600)
                self.assertNotIn(COOKIE,p.read_text());self.assertNotIn('subscription',p.read_text())
            self.assertEqual(json.loads((accountroot/'usage-action.json').read_text())['action'],NEW)
            # Exercise the real argparse/control dispatch, bound credentials and
            # transport wrapper together; replace only DNS and the HTTP session.
            class Options:
                PROXY='proxy'; CAINFO='ca'; SSL_VERIFYPEER='peer'; SSL_VERIFYHOST='host'; RESOLVE='resolve'
            calls=[]
            class Session:
                def __init__(self,**kw):pass
                def __enter__(self):return self
                def __exit__(self,*a):pass
                def request(self,method,url,**kw):
                    calls.append((method,url,kw['headers']))
                    kw['content_callback'](response().body)
                    return SimpleNamespace(status_code=200,headers={},primary_ip=IP)
            from metamuse import _muse_adapters
            argv=['hub_core.py','--legacy',str(legacy),'--mode','live','usage-read']
            out=io.StringIO()
            with patch.object(sys,'argv',argv),patch.object(_muse_adapters,'resolve_all',resolve),\
                 patch.object(usage.http,'load_curl',return_value=(Session,None,Options)),\
                 patch.object(usage.http,'_ca_bundle',return_value='/synthetic/ca'),contextlib.redirect_stdout(out):
                core.main()
            self.assertEqual(json.loads(out.getvalue())['usage']['usedPercent'],23)
            result=json.loads(out.getvalue())
            self.assertEqual(len(calls),1);self.assertEqual(calls[0][0],'POST')
            self.assertNotIn(COOKIE,out.getvalue())
            self.assertFalse((legacy/'projects').exists())
            args.operation='usage-status';args.mode='offline'
            with patch.object(usage.BoundMuseCredentials,'cookies',side_effect=AssertionError('status must not read secret')):
                self.assertEqual(usage.control(core,args,client=Client([]),resolver=resolve),result)
            args.operation='usage-read';args.mode='live';c=Client([response(status=403)])
            self.assertEqual(usage.control(core,args,client=c,resolver=resolve),{'usage':None,'error':'auth'})
            self.assertEqual(len(c.calls),1)
            args.operation='usage-status';args.mode='offline'
            self.assertEqual(usage.control(core,args,client=Client([]),resolver=resolve),{'usage':None,'error':'auth'})
            args.operation='usage-read';args.mode='live'
            with patch.object(usage.BoundMuseCredentials,'cookies',side_effect=ValueError(COOKIE)):
                self.assertEqual(usage.control(core,args,client=Client([]),resolver=resolve),{'usage':None,'error':'auth'})
            args.operation='usage-status';args.mode='offline'
            self.assertEqual(usage.control(core,args,client=Client([]),resolver=resolve),{'usage':None,'error':'auth'})
            with core.locked(legacy/'.registration.lock',create=False), self.assertRaises(BlockingIOError):
                usage.control(core,args,client=Client([]),resolver=resolve)

    def test_launcher_uses_only_account_usage_directory_without_any_task(self):
        launcher=load('usage_launcher',HERE/'hub_launcher.py')
        bundle=HERE.parents[2]/'.ai/work/metamuse-local-20261024'
        with tempfile.TemporaryDirectory(prefix='hub-usage-launch-',dir='/private/tmp') as td:
            home=Path(td);private=home/'Library/Application Support/metamuse-hub-20260926-hub-v2'
            for operation,profile,mode in [('usage-status','hub-approval.sb','offline'),('usage-read','hub-live.sb','live')]:
                calls=[]
                with patch.object(sys,'argv',['launcher','--bundle',str(bundle),operation]),\
                     patch.object(launcher.pwd,'getpwuid',return_value=SimpleNamespace(pw_dir=str(home))),\
                     patch.object(launcher.os,'execve',side_effect=lambda *a:calls.append(a)),\
                     patch.object(launcher.os,'chdir'),patch.object(launcher.os,'umask'),\
                     patch.object(launcher.resource,'setrlimit'):
                    launcher.main()
                self.assertEqual(len(calls),1)
                executable,cmd,env=calls[0]
                self.assertEqual(executable,'/usr/bin/sandbox-exec')
                self.assertIn(str(HERE/profile),cmd)
                self.assertIn('taskroot='+str(private/'usage'),cmd)
                self.assertIn('project='+str(private/'usage'),cmd)
                child=cmd[cmd.index(str(HERE/'hub_core.py'))+1:]
                self.assertEqual(child,['--legacy',str(private),'--mode',mode,operation])
                self.assertIn(str(bundle/'.venv/bin/python'),cmd)
                self.assertFalse(private.exists())
            with patch.object(sys,'argv',['launcher','--bundle',str(bundle),'menu']),contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):
                launcher.main()
            with patch.object(sys,'argv',['core','--legacy',str(private),'request']),contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):
                core.main()

if __name__=='__main__':unittest.main()

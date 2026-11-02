"""Task-only synthetic adapter, archive and download tests. Never starts Chromium."""
import ast
import hashlib
from email.message import Message
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).resolve().parents[1] / 'lib/muse'
BUNDLE = HERE.parents[2] / '.ai/work/metamuse-local-20261024'
sys.path.insert(0, str(HERE))
import extras
import facebook_runtime as runtime
import browser_download as download


def archive(rows):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as z:
        for name, data, mode in rows:
            item = zipfile.ZipInfo(name); item.create_system = 3; item.external_attr = mode << 16
            z.writestr(item, data)
    return stream.getvalue()


def core_helpers():
    tree = ast.parse((HERE / 'hub_core.py').read_text())
    selected = ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ('checked','save','private_dir')], type_ignores=[])
    space = {'Path':Path, 'os':os, 'stat':stat}
    exec(compile(selected, '<filesystem helpers>', 'exec'), space)
    return SimpleNamespace(**{n:space[n] for n in ('checked','save','private_dir')})


class Synthetic(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='muse-r02b-', dir='/private/tmp')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve(); self.root.chmod(0o700)
        self.row = {'version':'153.0.8010.12', 'revision':'1243',
            'url':'https://cdn.playwright.dev/builds/cft/153.0.8010.12/mac-arm64/chrome-mac-arm64.zip',
            'executable_relative_path':'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
            'sha256':None, 'bytes':None}
        self.patches = [patch.object(extras, '_core', return_value=core_helpers()),
            patch.object(extras, '_local_lock', side_effect=lambda r:{'chromium':self.row}),
            patch.object(runtime, '_extras', return_value=extras), patch.object(extras, '_facebook_runtime', return_value=runtime), patch.object(download, 'extras', extras)]
        for p in self.patches: p.start(); self.addCleanup(p.stop)

    def install(self, rows=None):
        rows = rows or [(self.row['executable_relative_path'], b'never execute synthetic browser', 0o100755),
            ('chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/F.framework/Versions/A/real',b'data',0o100644),
            ('chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/F.framework/Versions/Current','A',0o120777),
            ('chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/F.framework/real','Versions/Current/real',0o120777)]
        data=archive(rows); self.row.update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
        staging=self.root/'extras-archives'; staging.mkdir(mode=0o700)
        path=staging/'chrome-mac-arm64.zip'; path.write_bytes(data); path.chmod(0o600)
        with patch.object(extras,'_approve',return_value=True):
            return extras.install_browser_archive(self.root)

    def test_framework_chain_extract_and_runtime_tampering(self):
        self.assertEqual(self.install()['adapter'],'verified')
        with patch.object(extras,'browser_interpreter',return_value=BUNDLE/'.venv/bin/python'):
            cache=runtime.require_supported_runtime(self.root,BUNDLE)
            self.assertEqual(runtime.profile_name('live','metamuse_collect',True,self.root,BUNDLE),'hub-fb-live.sb')
            wrapper=cache/'chromium-1243/chrome-linux64/chrome'
            self.assertIn('"$@"',wrapper.read_text()); self.assertNotIn('--no-sandbox',wrapper.read_text())
            wrapper.write_text(wrapper.read_text()+'# changed\n')
            with self.assertRaisesRegex(ValueError,'verification failed'):runtime.require_supported_runtime(self.root,BUNDLE)

    def test_browser_and_link_tree_tampering(self):
        self.install()
        target=self.root/'extras-browser'
        executable=target/self.row['executable_relative_path']; executable.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'tree changed'):extras.validate_browser_archive(self.root)
        self.assertRaises(ValueError,runtime.require_supported_runtime)

    def test_revision_from_lock_and_quoted_path(self):
        self.row['revision']='9999'
        self.install()
        self.assertTrue((self.root/'facebook-browser-cache/chromium-9999/chrome-linux64/chrome').is_file())
        self.assertFalse((self.root/'facebook-browser-cache/chromium-1243').exists())
        # Syntax only. No shell/browser process is executed.
        row,executable,cache,wrapper,script=runtime._layout(self.root,extras)
        self.assertIn(str(executable),script)
        self.assertIn('env -i',script)

    def test_link_escape_cycles_dangling_and_cross_app_rejected(self):
        base='chrome/A.app/Contents/'
        cases=[[(base+'x','/etc/passwd',0o120777)],[(base+'x','../../../out',0o120777)],
            [(base+'x','y',0o120777),(base+'y','x',0o120777)],[(base+'x','missing',0o120777)],
            [(base+'x','../../B.app/x',0o120777)],[(base+'x','ok',0o120777),(base+'x/a',b'x',0o100644)],
            [(base+'x','ok\x00evil',0o120777)],[(base+'x','C:\\bad',0o120777)]]
        for rows in cases:
            with self.subTest(rows=rows),zipfile.ZipFile(io.BytesIO(archive(rows))) as z:
                with self.assertRaises(ValueError):extras._zip_entries(z,browser_links=True)
        with zipfile.ZipFile(io.BytesIO(archive([(base+'x','y',0o120777),(base+'y',b'ok',0o100644)]))) as z:
            with self.assertRaisesRegex(ValueError,'link/special'):extras._zip_entries(z)

    def test_nested_app_internal_link_and_privileged_link_rejection(self):
        root='chrome/Main.app/Contents/Helpers/Helper.app/Contents/'
        with zipfile.ZipFile(io.BytesIO(archive([(root+'data',b'ok',0o100644),(root+'alias','data',0o120777)]))) as z:
            self.assertEqual(len(extras._zip_entries(z,browser_links=True)),2)
        with zipfile.ZipFile(io.BytesIO(archive([(root+'data',b'ok',0o100644),(root+'alias','data',0o124777)]))) as z:
            with self.assertRaisesRegex(ValueError,'unsafe permissions'):extras._zip_entries(z,browser_links=True)

    def test_download_response_headers_are_exact_and_bounded(self):
        for values,encoding in [([],None),(['1','1'],None),(['-1'],None),(['0'],None),(['999999999999'],None),(['3'],'gzip')]:
            message=Message()
            for value in values:message['Content-Length']=value
            if encoding:message['Content-Encoding']=encoding
            with self.assertRaises(ValueError):download.response_size(SimpleNamespace(headers=message))

    def test_existing_archive_guards_still_apply(self):
        for rows in [[('../x',b'x',0o100644)],[('a',b'x',0o100644),('A',b'x',0o100644)],
                     [('a',b'x',0o100666)],[('a',b'x',0o010644)]]:
            with zipfile.ZipFile(io.BytesIO(archive(rows))) as z:
                with self.assertRaises(ValueError):extras._zip_entries(z,browser_links=True)
        with zipfile.ZipFile(io.BytesIO(archive([('a',b'123',0o100644)]))) as z:
            with self.assertRaisesRegex(ValueError,'expansion'):extras._zip_entries(z,limit=2,browser_links=True)

    def test_rejected_install_and_incomplete_retry(self):
        self.install()
        with patch.object(extras,'_approve',return_value=True):
            with self.assertRaisesRegex(ValueError,'no overwrite'):extras.install_browser_archive(self.root)

    def fake_opener(self, payload=b'synthetic archive', length=None):
        calls=[]
        url=self.row['url']; size=len(payload) if length is None else length
        class Response(io.BytesIO):
            status=200
            def __init__(self, data):
                super().__init__(data); self.headers=Message(); self.headers['Content-Length']=str(size)
            def geturl(self):return url
        def open(req,timeout):
            calls.append(req.get_method()); return Response(payload if req.get_method()=='GET' else b'')
        return SimpleNamespace(open=open),calls

    def test_download_no_approval_no_network(self):
        opener,calls=self.fake_opener()
        with patch.object(extras,'_approve',return_value=False),patch.object(sys.stdin,'isatty',return_value=True),patch.object(sys.stdout,'isatty',return_value=True),patch.object(sys.stderr,'isatty',return_value=True):
            self.assertTrue(download.download(self.root,opener=opener)['cancelled'])
        self.assertEqual(calls,[]);self.assertFalse((self.root/'chromium-download').exists())

    def test_download_two_approvals_candidate_fixed_and_no_repeat(self):
        opener,calls=self.fake_opener()
        with patch.object(extras,'_approve',return_value=True) as approve,patch.object(sys.stdin,'isatty',return_value=True),patch.object(sys.stdout,'isatty',return_value=True),patch.object(sys.stderr,'isatty',return_value=True):
            result=download.download(self.root,opener=opener)
            self.assertEqual(calls,['HEAD','GET']);self.assertEqual(approve.call_count,2)
            candidate=json.loads(Path(result['candidate_json']).read_text())
            self.assertEqual(candidate['sha256'],hashlib.sha256(b'synthetic archive').hexdigest())
            self.assertEqual(extras.download_candidate(self.root),candidate)
            path=Path(result['candidate_json']);before=path.read_text();path.write_text(before.replace(candidate['sha256'],'0'*64))
            with self.assertRaisesRegex(ValueError,'differs from receipt'):extras.download_candidate(self.root)
            path.write_text(before)
            self.assertIsNone(self.row['sha256'])
            with self.assertRaisesRegex(ValueError,'no overwrite'):download.download(self.root,opener=opener)
            self.assertEqual(calls,['HEAD','GET'])

    def test_head_only_refusal_get_mismatch_and_non_tty(self):
        opener,calls=self.fake_opener()
        with patch.object(extras,'_approve',side_effect=[True,False]),patch.object(sys.stdin,'isatty',return_value=True),patch.object(sys.stdout,'isatty',return_value=True),patch.object(sys.stderr,'isatty',return_value=True):
            self.assertTrue(download.download(self.root,opener=opener)['cancelled'])
        self.assertEqual(calls,['HEAD'])
        with patch.object(sys.stdin,'isatty',return_value=False):
            with self.assertRaisesRegex(ValueError,'human terminal'):download.download(self.root,opener=opener)

    def test_download_partial_failure_is_not_retried(self):
        opener,calls=self.fake_opener(length=100)
        with patch.object(extras,'_approve',return_value=True),patch.object(sys.stdin,'isatty',return_value=True),patch.object(sys.stdout,'isatty',return_value=True),patch.object(sys.stderr,'isatty',return_value=True):
            with self.assertRaisesRegex(ValueError,'incomplete'):download.download(self.root,opener=opener)
            self.assertTrue((self.root/'chromium-download/get-intent.json').is_file())
            self.assertFalse((self.root/'chromium-download/archive-candidate.json').exists())
            with self.assertRaises(ValueError):download.download(self.root,opener=opener)
        self.assertEqual(calls,['HEAD','GET'])

    def test_redirects_preserve_head_and_limit_destinations(self):
        from urllib.request import Request
        urls=download.destinations(self.row); handler=download.FixedRedirects(urls)
        request=handler.redirect_request(Request(urls[0],method='HEAD'),None,302,'',{},urls[1])
        self.assertEqual(request.get_method(),'HEAD')
        for url in ('http://127.0.0.1:4545','https://example.com/file'):
            with self.assertRaises(ValueError):handler.redirect_request(request,None,302,'',{},url)
        self.row['url']='https://example.com/file'
        with self.assertRaises(ValueError):download.destinations(self.row)



class Profiles(unittest.TestCase):
    def test_ephemeral_fb_proxy_and_local_service_denies_only_for_fb(self):
        with tempfile.TemporaryDirectory(prefix='muse-r02b-os-', dir='/private/tmp') as tmp:
            root=Path(tmp); task=root/'private/projects/Synthetic/task'; task.mkdir(parents=True,mode=0o700)
            secret=task/'credential-intake/fixture';secret.parent.mkdir(mode=0o700);secret.write_text('SYNTHETIC')
            params=['-D','bundle='+str(BUNDLE),'-D','bridge='+str(HERE),'-D','private='+str(root/'private'),
                '-D','taskroot='+str(task),'-D','taskparent='+str(task.parent),'-D','project='+str(root/'project')]
            probe='''import json,pathlib,socket,sys
profile=sys.argv[1]
def denied(action):
 try: action(); return False
 except PermissionError: return True
 except OSError: return False
def bind(host,port,family=socket.AF_INET):
 with socket.socket(family) as s:s.bind((host,port))
def connect(port):
 with socket.socket() as s:s.settimeout(1);s.connect(('127.0.0.1',port))
result={'hub_denied':denied(lambda:connect(4545)),'known_service_denied':denied(lambda:connect(5678)),
 'hub_bind_denied':denied(lambda:bind('127.0.0.1',4545)),
 'ipv6_denied':denied(lambda:bind('::1',0,socket.AF_INET6)),
 'other_address_denied':denied(lambda:bind('127.0.0.2',0)),
 'intake_denied':denied(lambda:pathlib.Path(sys.argv[2]).read_bytes())}
if profile=='fb-live':
 with socket.socket() as s:
  s.settimeout(2);s.bind(('127.0.0.1',0));s.listen(1)
  with socket.socket() as c:
   c.settimeout(2);c.connect(s.getsockname());a,_=s.accept();a.close()
 result['ephemeral_connected']=True
else:result['ephemeral_denied']=denied(lambda:bind('127.0.0.1',0))
print(json.dumps(result))
'''
            for profile in ('fb-live','live','offline','human','download'):
                run=subprocess.run(['/usr/bin/sandbox-exec',*params,'-f',str(HERE/('hub-'+profile+'.sb')),
                    str(BUNDLE/'.venv/bin/python'),'-I','-B','-c',probe,profile,str(secret)],capture_output=True,text=True,timeout=15,
                    env={'PATH':'/usr/bin:/bin','LANG':'en_US.UTF-8'})
                self.assertEqual(run.returncode,0,(profile,run.stderr))
                result=json.loads(run.stdout)
                self.assertEqual(result.pop('intake_denied'),profile not in ('human','download'))
                self.assertTrue(all(result.values()),(profile,result))

    def test_real_upstream_discovery_without_test_hook_or_browser(self):
        import types
        from metamuse import facebook
        with tempfile.TemporaryDirectory(prefix='muse-r02b-discovery-') as tmp:
            root=Path(tmp);pkg=root/'playwright'; pkg.mkdir()
            meta=pkg/'driver/package/browsers.json';meta.parent.mkdir(parents=True)
            meta.write_text(json.dumps({'browsers':[{'name':'chromium','revision':'9876'}]}))
            executable=root/'cache/chromium-9876/chrome-linux64/chrome';executable.parent.mkdir(parents=True)
            executable.write_bytes(b'NEVER EXECUTED'); executable.chmod(0o700)
            module=types.ModuleType('playwright');module.__file__=str(pkg/'__init__.py')
            with patch.dict(sys.modules,{'playwright':module}),patch.dict(os.environ,{'PLAYWRIGHT_BROWSERS_PATH':str(root/'cache')}):
                self.assertEqual(facebook.find_playwright_browser(),executable)

    def test_synthetic_exec_wrapper_preserves_arguments_and_minimal_environment(self):
        # Only a harmless shell fixture runs, never a browser or third-party package.
        case=Synthetic();case.setUp()
        try:
            case.install()
            executable=case.root/'extras-browser'/case.row['executable_relative_path']
            executable.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\nprintf "SECRET=%s\\n" "${SYNTHETIC_SECRET-unset}"\n')
            # Receipt predates fixture replacement: use the already-generated wrapper,
            # and show that the verifier separately refuses its modified target.
            wrapper=case.root/'facebook-browser-cache/chromium-1243/chrome-linux64/chrome'
            args=['two words',"quote'","$(not executed)",'--proxy-server=http://127.0.0.1:12345']
            result=subprocess.run([str(wrapper),*args],capture_output=True,text=True,env={**os.environ,'SYNTHETIC_SECRET':'hidden'},timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout.splitlines(),[*args,'SECRET=unset'])
            with self.assertRaisesRegex(ValueError,'changed'):extras.validate_browser_archive(case.root)
        finally:case.doCleanups()

class Launcher(unittest.TestCase):
    def test_fb_only_profile_interpreter_environment_and_human_download_handoff(self):
        spec=importlib.util.spec_from_file_location('launcher_test',HERE/'hub_launcher.py')
        launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)
        class Executed(BaseException):pass
        with tempfile.TemporaryDirectory(prefix='muse-r02b-launch-',dir='/private/tmp') as tmp:
            root=Path(tmp);bundle=root/'Work/P/task/.ai/work/bundle';bundle.mkdir(parents=True)
            project=root/'Product/Synthetic';task=project/'.ai/tasks/task.md';task.parent.mkdir(parents=True);task.write_text('synthetic')
            taskroot=root/'Library/Application Support/metamuse-hub-20260926-hub-v2/projects/Synthetic/task'
            cache=taskroot/'facebook-browser-cache';base=bundle/'.venv/bin/python';browser=taskroot/'extras-browser-venv/bin/python'
            for fb,operation in ((True,'metamuse_collect'),(False,'metamuse_collect'),(False,'metamuse_muse_send'),(False,'menu')):
                executions=[]
                modules={'settings_terminal':{'verify_bundle':lambda b:None},
                    'hub_extras':{'interpreter':lambda b,t: (_ for _ in ()).throw(ValueError('partial environment')) if operation=='menu' else base,'browser_interpreter':lambda b,t:browser},
                    'hub_facebook_runtime':{'profile_name':lambda mode,op,isfb,t,b:'hub-fb-live.sb' if mode=='live' and isfb else 'hub-live.sb' if mode=='live' else 'hub-human.sb' if op=='menu' else 'hub-offline.sb',
                        'require_supported_runtime':lambda t,b:cache}}
                def fake_spec(name,path):
                    return SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module:module.__dict__.update(modules[name])))
                def run(command,**kw):
                    if operation=='menu':
                        self.assertIn(str(base),command)
                        self.assertIn(str(HERE/'hub_core.py'),command)
                        return SimpleNamespace(returncode=15)
                    return SimpleNamespace(returncode=0,stdout=json.dumps({'live':True,'digest':'a'*64,'facebook_collection':fb}))
                def execute(path,argv,env):executions.append((path,argv,env));raise Executed()
                with patch.object(launcher.importlib.util,'spec_from_file_location',side_effect=fake_spec),patch.object(launcher.importlib.util,'module_from_spec',side_effect=lambda spec:SimpleNamespace()), \
                    patch.object(launcher.pwd,'getpwuid',return_value=SimpleNamespace(pw_dir=str(root))),patch.object(launcher.os,'execve',side_effect=execute), \
                    patch.object(launcher.os,'chdir'),patch.object(launcher.os,'umask'),patch.object(launcher.resource,'setrlimit'),patch.object(launcher.subprocess,'run',side_effect=run), \
                    patch.object(sys,'argv',['launcher','--bundle',str(bundle),'--project','Synthetic','--task','task',operation]), \
                    patch.object(sys.stdin,'isatty',return_value=True),patch.object(sys.stdout,'isatty',return_value=True),patch.object(sys.stderr,'isatty',return_value=True):
                    with self.assertRaises(Executed):launcher.main()
                path,argv,env=executions[0]
                self.assertEqual(path,'/usr/bin/sandbox-exec')
                expected='hub-download.sb' if operation=='menu' else 'hub-fb-live.sb' if fb else 'hub-live.sb'
                self.assertEqual(argv[argv.index('-f')+1],str(HERE/expected))
                if fb:
                    self.assertEqual(env['PLAYWRIGHT_BROWSERS_PATH'],str(cache));self.assertIn(str(browser),argv)
                else:self.assertNotIn('PLAYWRIGHT_BROWSERS_PATH',env);self.assertIn(str(base),argv)
                if operation=='menu':self.assertIn(str(HERE/'browser_download.py'),argv);self.assertNotIn(str(HERE/'hub_core.py'),argv)


if __name__=='__main__':unittest.main(verbosity=2)

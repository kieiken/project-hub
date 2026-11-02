"""Synthetic task-scoped integration; no account, actual private root or network."""
import contextlib
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

CORE = Path(__file__).resolve().parents[1] / 'lib/muse/hub_core.py'
spec = importlib.util.spec_from_file_location('bridge', CORE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
from metamuse import app, models as m
from metamuse import safety
from metamuse import _muse_research as research


class Journey(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='hub-muse-new-', dir='/private/tmp')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.legacy = self.root / 'private'
        self.legacy.mkdir(mode=0o700)
        self.project = self.root / 'project'
        self.project.mkdir(mode=0o700)
        self.inputs = self.root / 'inputs'
        self.inputs.mkdir(mode=0o700)
        self.taskroot = self.legacy / 'projects' / 'Synthetic' / 'task'
        self.b = self.new_bridge()

    def new_bridge(self):
        return bridge.Bridge(self.taskroot, self.project, self.inputs, self.legacy, 'Synthetic', 'task', fixture=True)

    def call(self, tool, request, run=False):
        value = self.b.call('metamuse_' + tool, request, run=run)
        self.assertNotEqual(value.status, 'error', value)
        return value

    def packet(self):
        result = self.call('collect', {'inputs': [{'kind': 'text', 'text': 'Synthetic workshop had twelve seats. Attendance is unknown.'}],
                                      'resources': ['post'], 'limits': {'max_urls': 1, 'max_items': 2, 'max_bytes': 10000, 'wall_clock_seconds': 30},
                                      'access_grant_id': None, 'request_key': 'import'}, True)
        self.assertEqual(result.data['job']['state'], 'succeeded', result)
        found = self.call('search', {'query': 'Synthetic'})
        refs = [x['ref'] for x in found.data['results']]
        self.assertTrue(refs)
        return self.call('packet_prepare', {'selection': refs, 'request_key': 'packet'}).data

    def approve_fixture(self, pkt, expires=None):
        # Isolated synthetic operator, not a live account or an AI-issued live permit.
        self.b.ctx.non_interactive = False
        request = {'project_id': self.b.project_id, 'topic': 'Synthetic workshop', 'request_key': 'open'}
        with self.b.ctx.store.connection() as conn:
            review = research.prepare_research(self.b.ctx, request, packet_id=pkt['id'], rounds=2, max_reads=3,
                     expires_at=expires or (datetime.now(timezone.utc) + timedelta(minutes=20)).isoformat(), request_key='research', conn=conn)
        value = research.issue_research(self.b.ctx, review)
        self.b.ctx.non_interactive = True
        self.assertEqual(value.status, 'ok', value)
        return request, value.data

    def approval_request(self):
        with self.b.open():
            pkt = self.packet()
        request = {'open_request': {'topic': 'Synthetic workshop', 'request_key': 'open'},
                   'packet_id': pkt['id'], 'rounds': 2, 'max_reads': 3,
                   'expires_at': (datetime.now(timezone.utc) + timedelta(minutes=20)).isoformat(),
                   'request_key': 'ui-research'}
        return request

    @patch('time.sleep', return_value=None)
    def test_direct_chat_exact_scope_followup_and_external_reply(self, _sleep):
        spec = importlib.util.spec_from_file_location('direct_chat', CORE.with_name('direct_chat.py'))
        direct = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(direct)
        def envelope(question, n):
            key = 'direct_' + ('00000000-0000-4000-8000-%012d' % n)
            return {'schema': 1, 'id': key, 'project': 'Synthetic', 'task': 'task', 'kind': 'direct',
                    'request': {'question': question, 'materials': [{'name': 'selected.md', 'text': 'Only this explicit material.'}],
                                'expires_at': (datetime.now(timezone.utc) + timedelta(minutes=9)).isoformat(), 'request_key': key}}
        with self.b.open():
            self.call('collect', {'inputs': [{'kind': 'text', 'text': 'Unselected earlier history about penguins.'}],
                      'resources': ['post'], 'limits': {'max_urls': 1, 'max_items': 2, 'max_bytes': 10000, 'wall_clock_seconds': 30},
                      'access_grant_id': None, 'request_key': 'hidden-import'}, True)
            first = direct.execute(self.b, envelope('Direct synthetic question?', 1))
        self.b = self.new_bridge()
        with self.b.open():
            second = direct.execute(self.b, envelope('Follow up synthetic question?', 2))
            self.assertEqual(first['status'], 'received')
            self.assertTrue(first['text'])
            self.assertFalse(first['completion_verified'])
            self.assertEqual(first['discussion_id'], second['discussion_id'])
            self.assertNotEqual(first['exchange_id'], second['exchange_id'])
            with self.b.ctx.store.connection() as conn:
                packets = conn.execute('SELECT rendered_text FROM packets').fetchall()
            # Inspect the exact packet references used by each send, not workspace search results.
            for row in packets:
                self.assertNotIn('earlier history about penguins', str(row))

    @patch('time.sleep', return_value=None)
    def test_direct_limit_followup_unsent_proof_and_closed_exchange_resume(self, _sleep):
        spec = importlib.util.spec_from_file_location('direct_limit', CORE.with_name('direct_chat.py'))
        direct = importlib.util.module_from_spec(spec); spec.loader.exec_module(direct)
        directory = self.project / '.ai/muse-approvals'
        bridge.private_dir(directory / '.decisions/task')
        def reserve(n):
            key = 'direct_00000000-0000-4000-8000-%012d' % n
            request = {'question':'Synthetic follow-up %d?' % n, 'materials':[],
                'expires_at':(datetime.now(timezone.utc)+timedelta(minutes=9)).isoformat(), 'request_key':key}
            envelope = {'schema':1,'project':'Synthetic','task':'task','id':key,'kind':'direct','request':request}
            file = directory / (key+'.json'); bridge.save(file,json.dumps(envelope))
            decision = {'schema':1,'project':'Synthetic','task':'task','id':key,'decision':'approve','state':'unknown',
                'requestSHA':hashlib.sha256(file.read_bytes()).hexdigest(),'digest':m.payload_digest(request),
                'at':datetime.now(timezone.utc).isoformat()}
            bridge.save(directory/'.decisions/task'/(key+'.json'),json.dumps(decision))
            return file,envelope,decision
        for n in (61,62,63):
            file,e,d = reserve(n)
            with self.new_bridge().open() as b:
                b.reserve_approval_issue(file,e,d['requestSHA'],d['digest'])
                last = direct.execute(b,e)
                self.assertEqual(last['status'],'received',last)
        file,e,d = reserve(64)
        with self.new_bridge().open() as b:
            b.reserve_approval_issue(file,e,d['requestSHA'],d['digest'])
            before = b.permits()
            with patch.object(b,'call',wraps=b.call) as calls:
                stopped = direct.execute(b,e)
            self.assertEqual(stopped,{'status':'not-sent','diagnostic':{'code':'exchange_limit','phase':'send_prepare','open_confirmed':True}})
            self.assertEqual(before,b.permits())
            self.assertFalse(any(x.args[0] in ('metamuse_muse_open','metamuse_muse_read','metamuse_muse_close_exchange','metamuse_muse_send') for x in calls.call_args_list))
        # Reproduce the old bug exactly: the host passes preflight, then upstream
        # rejects the send at three after issuing the unused permit and closing
        # the previous exchange. All traffic stays in the synthetic fixture.
        file,e,d = reserve(65)
        with self.new_bridge().open(direct=True) as b:
            b.reserve_approval_issue(file,e,d['requestSHA'],d['digest'])
            actual = b.approval
            def grant(kind, request, checked_digest=None):
                result = actual(kind,request,checked_digest)
                if request.get('operation') == 'muse.send' and checked_digest:
                    b.ctx.limits.max_exchanges = 3
                return result
            with patch.object(b,'approval',side_effect=grant):
                old_failure = direct.execute(b,e)
            self.assertEqual(old_failure,{'status':'unknown','diagnostic':{'code':'send_uncertain','phase':'send','open_confirmed':True}})
        reservation = directory/'.decisions/task'/(e['id']+'.json')
        bridge.save(reservation,json.dumps({**d,'diagnostic':old_failure['diagnostic']}))
        def snapshot():
            return {str(p.relative_to(self.root)):(p.read_bytes(),p.stat().st_mode,p.stat().st_mtime_ns)
                    for p in self.root.rglob('*') if p.is_file()}
        before = snapshot()
        with self.new_bridge().open_preview() as b, patch.object(b,'call',side_effect=AssertionError('no calls')), patch.object(b,'approval',side_effect=AssertionError('no permits')), patch.object(b.ctx.secret_store,'resolve',side_effect=AssertionError('no secrets')):
            proof = direct.inspect_unsent(b,file)
            self.assertEqual(proof['scope'],'follow-up-none')
        self.assertEqual(before,snapshot())
        # Every mutable authority, session or receipt mismatch keeps the stop.
        with self.new_bridge().open() as b:
            with b.ctx.store.connection() as conn:
                row = conn.execute("SELECT response FROM request_receipts WHERE operation='permit.create' AND request_key=?",(e['id']+'-send-grant',)).fetchone()
                permit_id = json.loads(row['response'])['id']
                job = conn.execute('SELECT id,request_key,state FROM jobs ORDER BY rowid DESC LIMIT 1').fetchone()
            mutations = [
                ('UPDATE permits SET used=1 WHERE id=?',(permit_id,)),
                ('UPDATE permits SET revoked=1 WHERE id=?',(permit_id,)),
                ("UPDATE jobs SET state='queued' WHERE id=?",(job['id'],)),
                ("UPDATE jobs SET state='running' WHERE id=?",(job['id'],)),
                ('UPDATE jobs SET request_key=? WHERE id=?',(e['id']+'-send',job['id'])),
                ('INSERT INTO request_receipts VALUES(?,?,?,?)',('muse.send',e['id']+'-send','0'*64,'{}')),
            ]
        database = self.taskroot/'workspace/state.sqlite3'
        baseline = database.read_bytes()
        for sql,args in mutations:
            with self.new_bridge().open() as b, b.ctx.store.transaction() as conn:
                conn.execute(sql,args)
            with self.new_bridge().open_preview() as b, self.assertRaises((ValueError,m.CoreError)):
                direct.inspect_unsent(b,file)
            # Real schema consumption is monotonic; only this closed synthetic
            # database is restored, never a live permission or real record.
            database.write_bytes(baseline)
        session = self.taskroot/'inputs/direct-chat-session.json'
        original = session.read_text()
        bridge.save(session,json.dumps({'project':'Synthetic','task':'task','discussion_id':last['discussion_id'],'exchange_id':'wrong'}))
        with self.new_bridge().open_preview() as b, self.assertRaises((ValueError,m.CoreError)): direct.inspect_unsent(b,file)
        bridge.save(session,original)
        with self.new_bridge().open_preview() as b: self.assertEqual(direct.inspect_unsent(b,file)['scope'],'follow-up-none')
        # New entry point explicitly resets stale TOML limits. The previous
        # exchange is already closed; a fresh human turn skips closing it again.
        file,e,d = reserve(66)
        with self.new_bridge().open(direct=True) as b, patch.object(b,'call',wraps=b.call) as calls:
            self.assertEqual(b.ctx.limits.max_exchanges,30)
            resumed = direct.execute(b,e)
            self.assertEqual(resumed['status'],'received',resumed)
            self.assertEqual(resumed['discussion_id'],last['discussion_id'])
            self.assertFalse(any(x.args[0]=='metamuse_muse_close_exchange' for x in calls.call_args_list))
        self.assertEqual(bridge.load_config(self.taskroot/'workspace').limits.max_exchanges,30)
        before = snapshot()
        with self.new_bridge().open_preview() as b:
            self.assertEqual(b.ctx.limits.max_exchanges,3)
            with b.ctx.store.connection() as conn:
                packet_id = conn.execute('SELECT id FROM packets LIMIT 1').fetchone()['id']
            review = {'open_request':{'topic':'Synthetic research preview','request_key':'new-research-open'},
                'packet_id':packet_id,'rounds':3,'max_reads':3,
                'expires_at':(datetime.now(timezone.utc)+timedelta(minutes=9)).isoformat(),'request_key':'new-research'}
            self.assertEqual(b.approval('research',review)['rounds'],3)
            with self.assertRaisesRegex(m.CoreError,'exchange limit'):
                b.approval('research',{**review,'rounds':4})
        self.assertEqual(snapshot(),before)
        with self.new_bridge().open() as b: self.assertEqual(b.ctx.limits.max_exchanges,3)
        self.assertEqual(bridge.load_config(self.taskroot/'workspace').limits.max_exchanges,3)

    @patch('time.sleep', return_value=None)
    def test_live_contract_history_before_send_and_local_unsent_proof(self, _sleep):
        # Real live binding/policy/detector/permit/executor contract; replace only
        # the transport with an in-process wire simulator. No fixture backend
        # exemption, real credentials, sockets or remote service are involved.
        from metamuse import _muse_lifecycle as lifecycle
        from metamuse._muse_fixture import OfflineMuseGateway
        spec = importlib.util.spec_from_file_location('direct_live', CORE.with_name('direct_chat.py'))
        direct = importlib.util.module_from_spec(spec); spec.loader.exec_module(direct)
        metadata = safety.SecretStore(self.legacy / 'auth').put(
            b'{"format":"cookie-header","cookie_header":"synthetic=never-sent"}',
            provider='synthetic', account='synthetic', created_at=datetime.now(timezone.utc).isoformat())
        binding = m.MuseBinding(provider='synthetic',account='synthetic',auth_ref=metadata['auth_ref'])
        def live():
            return bridge.Bridge(self.taskroot,self.project,self.inputs,self.legacy,'Synthetic','task',binding=binding)
        directory = self.project / '.ai/muse-approvals'
        bridge.private_dir(directory / '.decisions/task')
        def reserve(n):
            key='direct_00000000-0000-4000-8000-%012d'%n
            request={'question':'Synthetic live contract question?', 'materials':[],
                     'expires_at':(datetime.now(timezone.utc)+timedelta(minutes=9)).isoformat(),'request_key':key}
            envelope={'schema':1,'project':'Synthetic','task':'task','id':key,'kind':'direct','request':request}
            file=directory/(key+'.json');bridge.save(file,json.dumps(envelope))
            decision={'schema':1,'project':'Synthetic','task':'task','id':key,'decision':'approve','state':'unknown',
                      'requestSHA':hashlib.sha256(file.read_bytes()).hexdigest(),'digest':m.payload_digest(request),
                      'at':datetime.now(timezone.utc).isoformat()}
            bridge.save(directory/'.decisions/task'/(key+'.json'),json.dumps(decision))
            return key,file,envelope,decision
        key,file,envelope,decision=reserve(31)
        gateway=OfflineMuseGateway()
        # A rejected history read models the old first-open state: open is acked,
        # while no send permit, send job or exchange has ever existed.
        with live().open(online=True) as b:
            actual_history=gateway.chat_history
            with patch.object(lifecycle,'MuseTransport',return_value=gateway), \
                 patch.object(gateway,'chat_history',side_effect=m.CoreError(m.ErrorCode.PROTOCOL_MISMATCH,'private transport error never returned')):
                b.reserve_approval_issue(file,envelope,decision['requestSHA'],decision['digest'])
                stopped=direct.execute(b,envelope)
            self.assertEqual(stopped,{'status':'rejected','diagnostic':{'code':'before_send_rejected','phase':'history','open_confirmed':True}})
            with b.ctx.store.connection() as conn:
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM exchanges").fetchone()[0],0)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM permits WHERE kind='share'").fetchone()[0],0)
                discussion=b.ctx.store.get(m.Discussion,json.loads((self.taskroot/'inputs/direct-chat-session.json').read_text())['discussion_id'])
                self.assertEqual(discussion.backend,'live')
                with self.assertRaisesRegex(m.CoreError,'authorized history baseline'):
                    lifecycle._history_baseline(b.ctx.store,discussion)
        def snapshot():
            return {str(p.relative_to(self.root)):(p.read_bytes(),p.stat().st_mode,p.stat().st_mtime_ns)
                    for p in self.root.rglob('*') if p.is_file()}
        before=snapshot()
        with live().open_preview() as b:
            proof=direct.inspect_unsent(b,file)
            self.assertEqual(proof['status'],'not-sent');self.assertTrue(proof['open_confirmed'])
            self.assertEqual(proof['requestSHA'],decision['requestSHA'])
        self.assertEqual(snapshot(),before)
        # Every identity/receipt/evidence mismatch fails closed; do not infer
        # non-delivery merely from a missing send row.
        reservation=directory/'.decisions/task'/(key+'.json')
        for delta in [{'state':'sent'},{'requestSHA':'0'*64},{'digest':'0'*64},{'grant':None}]:
            bridge.save(reservation,json.dumps({**decision,**delta}))
            with live().open_preview() as b, self.assertRaises(ValueError):direct.inspect_unsent(b,file)
        bridge.save(reservation,json.dumps(decision))
        marker=self.taskroot/('approval-issued-'+key+'.json')
        raw=marker.read_text();bridge.save(marker,json.dumps({**json.loads(raw),'digest':'0'*64}))
        with live().open_preview() as b,self.assertRaises(ValueError):direct.inspect_unsent(b,file)

        bridge.save(marker,raw)
        # A fresh human turn reuses the acknowledged session, never the burned
        # request. Both that turn and its follow-up require real stored history.
        for n in (32,33):
            _,new_file,e,d=reserve(n)
            with live().open(online=True) as b, patch.object(lifecycle,'MuseTransport',return_value=gateway):
                self.assertIsNone(b.ctx.muse_gateway)
                b.reserve_approval_issue(new_file,e,d['requestSHA'],d['digest'])
                actual_approval=b.approval
                def approve(kind,request,checked_digest=None):
                    if request.get('operation')=='muse.send':
                        with b.ctx.store.connection() as conn:
                            current=b.ctx.store.get(m.Discussion,discussion.id,conn=conn)
                            self.assertEqual(lifecycle._history_baseline(b.ctx.store,current)['basis'],'stored_history')
                    return actual_approval(kind,request,checked_digest)
                b.approval=approve
                result=direct.execute(b,e)
                self.assertEqual(result['status'],'received',result)
                self.assertEqual(result['discussion_id'],discussion.id)
        self.assertEqual(sum(k=='session.start' for k,_ in gateway.calls),1)
        self.assertEqual(sum(k=='chat.stream' for k,_ in gateway.calls),2)
        before=snapshot()
        with live().open_preview() as b,patch.object(b,'call',side_effect=AssertionError('local proof only')),patch.object(b,'approval',side_effect=AssertionError('no grants')),patch.object(b.ctx.secret_store,'resolve',side_effect=AssertionError('no secret resolve')):
            ack=direct.inspect_sent(b,new_file)
            self.assertEqual(ack['exchange_id'],result['exchange_id'])
            self.assertEqual(ack['scope'],'acknowledged-send')
        self.assertEqual(before,snapshot())
        with live().open_preview() as b,self.assertRaises(ValueError):direct.inspect_unsent(b,file)

    @patch('time.sleep', return_value=None)
    def test_live_initial_baseline_and_true_send_uncertainty(self, _sleep):
        from metamuse import _muse_lifecycle as lifecycle
        from metamuse._muse_fixture import OfflineMuseGateway
        spec=importlib.util.spec_from_file_location('direct_live_initial',CORE.with_name('direct_chat.py'))
        direct=importlib.util.module_from_spec(spec);spec.loader.exec_module(direct)
        metadata=safety.SecretStore(self.legacy/'auth').put(b'{"format":"cookie-header","cookie_header":"synthetic=never-sent"}',
            provider='synthetic',account='synthetic',created_at=datetime.now(timezone.utc).isoformat())
        binding=m.MuseBinding(provider='synthetic',account='synthetic',auth_ref=metadata['auth_ref'])
        b=bridge.Bridge(self.taskroot,self.project,self.inputs,self.legacy,'Synthetic','task',binding=binding)
        key='direct_00000000-0000-4000-8000-000000000041'
        envelope={'schema':1,'project':'Synthetic','task':'task','id':key,'kind':'direct','request':{
            'question':'Synthetic initial question?','materials':[],'request_key':key,
            'expires_at':(datetime.now(timezone.utc)+timedelta(minutes=9)).isoformat()}}
        directory=self.project/'.ai/muse-approvals';bridge.private_dir(directory/'.decisions/task')
        file=directory/(key+'.json');bridge.save(file,json.dumps(envelope))
        d={'schema':1,'project':'Synthetic','task':'task','id':key,'decision':'approve','state':'unknown',
           'digest':m.payload_digest(envelope['request']),'requestSHA':hashlib.sha256(file.read_bytes()).hexdigest(),
           'at':datetime.now(timezone.utc).isoformat()}
        bridge.save(directory/'.decisions/task'/(key+'.json'),json.dumps(d))
        gateway=OfflineMuseGateway(mode='send_timeout')
        with b.open(online=True),patch.object(lifecycle,'MuseTransport',return_value=gateway):
            b.reserve_approval_issue(file,envelope,d['requestSHA'],d['digest'])
            result=direct.execute(b,envelope)
            self.assertEqual(result,{'status':'unknown','diagnostic':{'code':'send_uncertain','phase':'send','open_confirmed':True}})
            with b.ctx.store.connection() as conn:
                discussion=b.ctx.store.get(m.Discussion,json.loads((self.taskroot/'inputs/direct-chat-session.json').read_text())['discussion_id'])
                self.assertEqual(discussion.backend,'live')
                self.assertEqual(lifecycle._history_baseline(b.ctx.store,discussion)['basis'],'stored_history')
                history_permits=[b.ctx.store.decode(m.Permit,x) for x in conn.execute("SELECT * FROM permits WHERE json_extract(scope,'$.operations[0]')='muse.read'")]
                self.assertEqual(len(history_permits),1)
                self.assertEqual(history_permits[0].used,1)
                self.assertEqual(history_permits[0].max_uses,1)
        self.assertEqual([k for k,_ in gateway.calls],['session.start','chat.history','chat.stream'])
        with bridge.Bridge(self.taskroot,self.project,self.inputs,self.legacy,'Synthetic','task',binding=binding).open_preview() as b, self.assertRaises(ValueError):
            direct.inspect_unsent(b,file)

    @patch('time.sleep', return_value=None)
    def test_direct_cli_requires_m1_reservation_and_burns_id_before_execution(self, _sleep):
        directory = self.project / '.ai/muse-approvals'
        bridge.private_dir(directory)
        key = 'direct_00000000-0000-4000-8000-000000000001'
        file = directory / (key + '.json')
        request = {'question': 'A direct synthetic question?', 'materials': [],
                   'expires_at': (datetime.now(timezone.utc) + timedelta(minutes=9)).isoformat(), 'request_key': key}
        envelope = {'schema':1, 'id':key, 'project':'Synthetic', 'task':'task', 'kind':'direct', 'request':request}
        bridge.save(file, json.dumps(envelope))
        digest = m.payload_digest(request)
        reservation = directory / '.decisions/task' / (key + '.json')
        bridge.private_dir(reservation.parent)
        decision = {'schema':1,'id':key,'project':'Synthetic','task':'task','decision':'approve','state':'unknown',
                    'digest':digest,'requestSHA':hashlib.sha256(file.read_bytes()).hexdigest(),'at':datetime.now(timezone.utc).isoformat()}
        def run(mode, checked=None):
            argv = ['core','--taskroot',str(self.taskroot),'--project-dir',str(self.project),'--inputs',str(self.inputs),
                    '--legacy',str(self.legacy),'--project','Synthetic','--task','task','--mode',mode,'--run',
                    *(['--checked-digest',checked] if checked else []),'direct-chat',str(file)]
            out = io.StringIO()
            instance = self.new_bridge()
            with patch.object(bridge,'Bridge',return_value=instance), patch.object(sys,'argv',argv), contextlib.redirect_stdout(out):
                bridge.main()
            return json.loads(out.getvalue())
        for delta in [None, {'state':'approved'}, {'grant':None}, {'digest':'0'*64}, {'requestSHA':'0'*64},
                      {'at':(datetime.now(timezone.utc)-timedelta(minutes=11)).isoformat()}]:
            if delta is not None: bridge.save(reservation,json.dumps({**decision,**delta}))
            with self.assertRaises(Exception): run('live',digest)
            with self.new_bridge().open_preview() as b: self.assertEqual(b.permits()['permits'],[])
            if reservation.exists(): reservation.unlink()
        bridge.save(reservation,json.dumps(decision))
        self.assertEqual(run('check')['digest'],digest)
        marker = self.taskroot / ('approval-issued-' + key + '.json')
        self.assertFalse(marker.exists())
        self.assertEqual(run('live',digest)['status'],'received')
        self.assertEqual(marker.stat().st_mode & 0o777,0o600)
        with self.new_bridge().open_preview() as b: before = b.permits()
        with self.assertRaises(Exception): run('live',digest)
        with self.new_bridge().open_preview() as b: self.assertEqual(before,b.permits())

    def test_m2_slow_send_and_authorized_read_only_recovery(self):
        directory = self.project / '.ai/muse-approvals'
        bridge.private_dir(directory)
        bridge.private_dir(directory / '.decisions/task')
        trace = []
        delayed = True
        def reserve(kind, key, request):
            file = directory / (key + '.json')
            envelope = {'schema':1,'id':key,'project':'Synthetic','task':'task','kind':kind,'request':request}
            bridge.save(file, json.dumps(envelope))
            d = {'schema':1,'id':key,'project':'Synthetic','task':'task','decision':'approve','state':'unknown',
                 'digest':m.payload_digest(request),'requestSHA':hashlib.sha256(file.read_bytes()).hexdigest(),
                 'at':datetime.now(timezone.utc).isoformat()}
            reservation = directory / '.decisions/task' / (key + '.json')
            bridge.save(reservation, json.dumps(d))
            return file, reservation, d
        def run(operation, file, digest=None, mode='live'):
            argv = ['core','--taskroot',str(self.taskroot),'--project-dir',str(self.project),'--inputs',str(self.inputs),
                    '--legacy',str(self.legacy),'--project','Synthetic','--task','task','--mode',mode,'--run',
                    *(['--checked-digest',digest] if digest else []),operation,str(file)]
            out = io.StringIO()
            instance = self.new_bridge()
            actual = instance.call
            def call(tool, request, **kwargs):
                trace.append((tool,dict(request)))
                if tool == 'metamuse_muse_read' and request.get('refresh'):
                    session = json.loads((self.taskroot / 'inputs/direct-chat-session.json').read_text())
                    self.assertEqual(session['exchange_id'], request['exchange_id'])
                result = actual(tool, request, **kwargs)
                if delayed and tool == 'metamuse_muse_read' and result.status == 'ok':
                    # Real upstream fixture runs/imports the reply. Hide it from
                    # the host for this first poll window to simulate latency.
                    result.data = {**result.data, 'messages':[]}
                return result
            instance.call = call
            with patch.object(bridge,'Bridge',return_value=instance), patch.object(sys,'argv',argv), \
                    patch('time.sleep') as sleep, contextlib.redirect_stdout(out):
                bridge.main()
            self.assertEqual(bridge.load_config(self.taskroot/'workspace').limits.max_exchanges,30)
            return json.loads(out.getvalue()), sleep
        key = 'direct_00000000-0000-4000-8000-000000000011'
        expires = (datetime.now(timezone.utc)+timedelta(minutes=9)).isoformat()
        file, reservation, decision = reserve('direct', key,
            {'question':'Slow synthetic question?', 'materials':[], 'expires_at':expires,'request_key':key})
        sent, sleep = run('direct-chat',file,decision['digest'])
        self.assertEqual(sent['status'],'sent')
        self.assertEqual(sleep.call_count,1)
        self.assertEqual([x.args[0] for x in sleep.call_args_list],[12])
        self.assertEqual(sum(t == 'metamuse_muse_send' for t,r in trace),1)
        self.assertEqual(sum(t == 'metamuse_muse_read' and r.get('refresh',False) for t,r in trace),2)
        self.assertEqual(json.loads((self.taskroot/'inputs/direct-chat-session.json').read_text())['exchange_id'],sent['exchange_id'])
        bridge.save(reservation,json.dumps({**decision,'state':'sent','result':sent}))
        delayed = False
        read_key = 'read_00000000-0000-4000-8000-000000000012'
        read_file, read_reservation, read_decision = reserve('direct-read',read_key,
            {'source_id':key,'discussion_id':sent['discussion_id'],'exchange_id':sent['exchange_id'],
             'expires_at':expires,'request_key':read_key})
        with self.new_bridge().open_preview() as b: before = b.permits()
        trace.clear()
        for delta in [None, {'state':'sent'}, {'grant':None}, {'digest':'0'*64}, {'requestSHA':'0'*64},
                      {'at':(datetime.now(timezone.utc)-timedelta(minutes=11)).isoformat()}]:
            read_reservation.unlink(missing_ok=True)
            if delta is not None: bridge.save(read_reservation,json.dumps({**read_decision,**delta}))
            with self.assertRaises(Exception): run('direct-read',read_file,read_decision['digest'])
            with self.new_bridge().open_preview() as b: self.assertEqual(before,b.permits())
        # A read reservation must not turn an unknown send or another exchange
        # into readable authority, even if its own digest is otherwise valid.
        for delta in [{'state':'unknown'}, {'result':{**sent,'exchange_id':'wrong-exchange'}}]:
            bridge.save(reservation,json.dumps({**decision,'state':'sent','result':sent,**delta}))
            with self.assertRaises(Exception): run('direct-read',read_file,read_decision['digest'])
            with self.new_bridge().open_preview() as b: self.assertEqual(before,b.permits())
        bridge.save(reservation,json.dumps({**decision,'state':'sent','result':sent}))
        bridge.save(read_reservation,json.dumps(read_decision))
        marker = self.taskroot / ('approval-issued-'+read_key+'.json')
        self.assertEqual(run('direct-read',read_file,mode='check')[0]['digest'],read_decision['digest'])
        self.assertFalse(marker.exists())
        trace.clear()
        received, sleep = run('direct-read',read_file,read_decision['digest'])
        self.assertEqual(received['status'],'received')
        self.assertEqual(received['discussion_id'],sent['discussion_id'])
        self.assertEqual(received['exchange_id'],sent['exchange_id'])
        self.assertTrue(received['text'])
        self.assertEqual(sleep.call_count,1)
        self.assertEqual({t for t,r in trace},{'metamuse_muse_read'})
        with self.new_bridge().open_preview() as b:
            after = b.permits()
            self.assertEqual(len(after['permits']),len(before['permits'])+1)
            new = [p for p in after['permits'] if p['id'] not in {x['id'] for x in before['permits']}]
            permit = b.ctx.store.get(m.Permit,new[0]['id'])
            self.assertEqual(permit.kind,'access')
            self.assertEqual(permit.scope['operations'],['muse.read'])
            self.assertEqual(permit.max_uses,6)
            self.assertEqual(permit.used,2)
        self.assertTrue(marker.exists())
        with self.assertRaises(Exception): run('direct-read',read_file,read_decision['digest'])
        with self.new_bridge().open_preview() as b: self.assertEqual(after,b.permits())
        next_key = 'direct_00000000-0000-4000-8000-000000000013'
        next_file, _, next_decision = reserve('direct',next_key,
            {'question':'Explicit follow up?', 'materials':[], 'expires_at':expires,'request_key':next_key})
        followup, _ = run('direct-chat',next_file,next_decision['digest'])
        self.assertEqual(followup['status'],'received')
        self.assertEqual(followup['discussion_id'],sent['discussion_id'])
        self.assertNotEqual(followup['exchange_id'],sent['exchange_id'])

    def test_reply_stability_partial_resume_and_deadline(self):
        from types import SimpleNamespace
        spec=importlib.util.spec_from_file_location('stable_reply',CORE.with_name('direct_chat.py'))
        direct=importlib.util.module_from_spec(spec);spec.loader.exec_module(direct)
        memory={}
        b=SimpleNamespace(root=self.root,save_private=lambda p,t:memory.update({str(p):json.loads(t)}),
                          request=lambda p,**kw:memory[str(p)])
        r={'request_key':'direct_synthetic','expires_at':(datetime.now(timezone.utc)+timedelta(minutes=9)).isoformat()}
        intro={'id':'intro','role':'assistant','text':'Working on it.'}
        body={'id':'body','role':'assistant','text':'Complete substantive body.'}
        snapshots=iter([[intro],[intro,body],[intro,body]])
        refresh=[]
        def call(tool,request,*args):
            self.assertEqual(tool,'muse_read')
            if request.get('refresh'):
                refresh.append(request);return {}
            return {'discussion_id':'discussion','messages':next(snapshots)}
        with patch('time.sleep'):
            result=direct.receive(b,r,'discussion','exchange',call,lambda *a:'permit')
        self.assertEqual(result['status'],'received');self.assertIn(body['text'],result['text'])
        self.assertEqual(len(refresh),3)
        snapshots=iter([[intro],[intro,body]])
        with patch('time.sleep'):
            partial=direct.receive(b,r,'discussion','exchange',call,lambda *a:'permit',attempts=2)
        self.assertEqual(partial['status'],'sent');self.assertTrue(partial['partial'])
        self.assertIn(body['text'],partial['text'])
        snapshots=iter([[intro,body]])
        resumed=direct.receive(b,r,'discussion','exchange',call,lambda *a:self.fail('no new permit'),existing=True,attempts=1)
        self.assertEqual(resumed['status'],'received')
        # Changed message identity with identical text is still a new snapshot.
        snapshots=iter([[intro,{**body,'id':'new-body'}]])
        changed=direct.receive(b,r,'discussion','exchange',call,lambda *a:self.fail('no permit'),existing=True,attempts=1)
        self.assertEqual(changed['status'],'sent');self.assertTrue(changed['partial'])
        with patch.object(direct.time,'monotonic',return_value=100):
            stopped=direct.receive(b,r,'discussion','exchange',lambda *a:self.fail('past deadline'),lambda *a:'permit',end=90)
        self.assertEqual(stopped['status'],'sent')
        # No refresh may start with <=35 seconds left (30s read + cleanup).
        for now in (55, 56):
            with patch.object(direct.time,'monotonic',return_value=now):
                stopped=direct.receive(b,r,'discussion','exchange',lambda *a:self.fail('too close to deadline'),lambda *a:'permit',end=90)
            self.assertEqual(stopped['status'],'sent')
        snapshots=iter([[intro]])
        refresh.clear()
        with patch.object(direct.time,'monotonic',return_value=54),patch.object(direct.time,'sleep') as sleep:
            stopped=direct.receive(b,r,'discussion','exchange',call,lambda *a:'permit',end=90)
        self.assertEqual(len(refresh),1);sleep.assert_not_called()
        self.assertEqual(stopped['status'],'sent');self.assertTrue(stopped['partial'])
        # The process timer interrupts a blocking read before the Hub kills it.
        def blocking(*_):
            import time
            time.sleep(1)
        with direct.deadline(.02):
            stopped=direct.receive(b,r,'discussion','exchange',blocking,lambda *a:'permit')
        self.assertEqual(stopped['status'],'sent')
        # Eighteen seconds of stable introduction can still precede a body.
        # Subsequent polls use that same permit and see the later message.
        snapshots=iter([[intro],[intro],[intro,body],[intro,body]])
        refresh.clear();clock=[0]
        def advance(_seconds):
            clock[0]+=18
        with patch.object(direct.time,'monotonic',side_effect=lambda:clock[0]),patch.object(direct.time,'sleep',side_effect=advance):
            early=direct.receive(b,r,'discussion','exchange',call,lambda *a:'original-permit',attempts=2,end=90)
        self.assertEqual(clock[0],18);self.assertEqual(early['status'],'received')
        self.assertEqual(early['text'],intro['text'])
        for now,expected in ((120,'sent'),(240,'received')):
            with patch.object(direct.time,'monotonic',return_value=now):
                late=direct.receive(b,r,'discussion','exchange',call,lambda *a:self.fail('no new grant'),existing=True,attempts=1,end=now+90)
            self.assertEqual(late['status'],expected);self.assertIn(body['text'],late['text'])
        self.assertEqual(len(refresh),4)
        self.assertTrue(all(x['access_grant_id']=='original-permit' for x in refresh))

    @patch('time.sleep', return_value=None)
    def test_acknowledged_local_proof_and_original_poll_budget(self, _sleep):
        spec=importlib.util.spec_from_file_location('ack_reply',CORE.with_name('direct_chat.py'))
        direct=importlib.util.module_from_spec(spec);spec.loader.exec_module(direct)
        key='direct_00000000-0000-4000-8000-000000000081'
        directory=self.project/'.ai/muse-approvals';bridge.private_dir(directory/'.decisions/task')
        expiry=(datetime.now(timezone.utc)+timedelta(minutes=9)).isoformat()
        source={'schema':1,'id':key,'project':'Synthetic','task':'task','kind':'direct',
                'request':{'question':'Synthetic delayed reply?','materials':[],'expires_at':expiry,'request_key':key}}
        file=directory/(key+'.json');bridge.save(file,json.dumps(source))
        decision={'schema':1,'project':'Synthetic','task':'task','id':key,'decision':'approve','state':'unknown',
                  'requestSHA':hashlib.sha256(file.read_bytes()).hexdigest(),'digest':m.payload_digest(source['request']),
                  'at':datetime.now(timezone.utc).isoformat()}
        reservation=directory/'.decisions/task'/(key+'.json');bridge.save(reservation,json.dumps(decision))
        b=self.new_bridge()
        with b.open(direct=True):
            b.reserve_approval_issue(file,source,decision['requestSHA'],decision['digest'])
            actual=b.call
            def hidden(tool,request,**kw):
                result=actual(tool,request,**kw)
                if tool=='metamuse_muse_read' and result.status=='ok':result.data={**result.data,'messages':[]}
                return result
            with patch.object(b,'call',side_effect=hidden):sent=direct.execute(b,source)
            self.assertEqual(sent['status'],'sent')
        def snapshot():
            return {str(p):(p.read_bytes(),p.stat().st_mode,p.stat().st_mtime_ns) for p in self.root.rglob('*') if p.is_file()}
        before=snapshot()
        with self.new_bridge().open_preview() as b,patch.object(b,'call',side_effect=AssertionError('no calls')),patch.object(b,'approval',side_effect=AssertionError('no grants')),patch.object(b.ctx.secret_store,'resolve',side_effect=AssertionError('no secrets')):
            proof=direct.inspect_delivery(b,file)
            self.assertEqual(proof['status'],'sent');self.assertEqual(proof['scope'],'acknowledged-send')
            self.assertEqual(proof['exchange_id'],sent['exchange_id'])
        self.assertEqual(before,snapshot())
        # A single changed handoff, verdict, source or session must keep stopped.
        for delta in [{'attempt_verdict':'undecided'},{'bytes_handed_off':False},{'question':'changed'}]:
            with self.new_bridge().open_preview() as b:
                original_get=b.ctx.store.get
                def changed(model,identity,**kw):
                    value=original_get(model,identity,**kw)
                    return value.model_copy(update=delta) if model is m.Exchange else value
                with patch.object(b.ctx.store,'get',side_effect=changed),self.assertRaises((ValueError,m.CoreError)):
                    direct.inspect_delivery(b,file)
        # Stable introduction already marked received: the original permit is
        # still valid for late body text, without issuing any further grants.
        bridge.save(reservation,json.dumps({**decision,'state':'received','result':sent}))
        pollkey='read_00000000-0000-4000-8000-000000000082'
        envelope={'schema':1,'id':pollkey,'project':'Synthetic','task':'task','kind':'direct-poll','request':{
            'source_id':key,'discussion_id':sent['discussion_id'],'exchange_id':sent['exchange_id'],
            'request_key':pollkey,'expires_at':expiry}}
        pollfile=directory/(pollkey+'.json');bridge.save(pollfile,json.dumps(envelope))
        polldecision={'schema':1,'project':'Synthetic','task':'task','id':pollkey,'decision':'approve','state':'unknown',
            'requestSHA':hashlib.sha256(pollfile.read_bytes()).hexdigest(),'digest':m.payload_digest(envelope['request']),
            'at':datetime.now(timezone.utc).isoformat()}
        bridge.save(directory/'.decisions/task'/(pollkey+'.json'),json.dumps(polldecision))
        def run_poll(operation='direct-poll'):
            argv=['core','--taskroot',str(self.taskroot),'--project-dir',str(self.project),'--inputs',str(self.inputs),
                  '--legacy',str(self.legacy),'--project','Synthetic','--task','task','--mode','live','--run',
                  '--checked-digest',polldecision['digest'],operation,str(pollfile)]
            out=io.StringIO()
            with patch.object(bridge,'Bridge',return_value=self.new_bridge()),patch.object(sys,'argv',argv),contextlib.redirect_stdout(out):bridge.main()
            return json.loads(out.getvalue())
        with self.assertRaisesRegex(ValueError,'kind differ'):run_poll('direct-read')
        first=run_poll()
        self.assertEqual(first['status'],'sent');self.assertTrue(first['partial'])
        with self.assertRaises(Exception):run_poll()  # burned marker, no replay
        with self.new_bridge().open(direct=True) as b:
            statefile=self.taskroot/'inputs'/('direct-receive-'+key+'.json')
            permit_id=json.loads(statefile.read_text())['permit_id']
            self.assertEqual(b.ctx.store.get(m.Permit,permit_id).used,3)
            # Only the exact original expiry and original 6-use permit work.
            changed=json.loads(json.dumps(envelope));changed['request']['expires_at']=(datetime.now(timezone.utc)+timedelta(minutes=9,seconds=1)).isoformat()
            with self.assertRaises(ValueError):direct.validate_read(b,changed)
            changed['request']['expires_at']=(datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()
            with self.assertRaises(ValueError):direct.validate_read(b,changed)
            with patch.object(b,'approval',side_effect=AssertionError('poll must not issue grants')):
                second=direct.execute_read(b,envelope)
                self.assertEqual(second['status'],'received')
                direct.execute_read(b,envelope);direct.execute_read(b,envelope)
                self.assertEqual(b.ctx.store.get(m.Permit,permit_id).used,6)
                with self.assertRaises(ValueError):direct.execute_read(b,envelope)
            permit=b.ctx.store.get(m.Permit,permit_id)
            self.assertEqual(permit.max_uses,6)

    def test_ui_preview_is_readonly_issue_is_bounded_and_replay_safe(self):
        request = self.approval_request()
        def snapshot():
            return {str(p.relative_to(self.root)): (p.read_bytes(), p.stat().st_mode, p.stat().st_mtime_ns)
                    for p in self.root.rglob('*') if p.is_file()}
        before = snapshot()
        with self.new_bridge().open_preview() as b:
            preview = b.approval('research', request)
            self.assertIn('Synthetic workshop had twelve seats', preview['packet_full_text'])
            self.assertEqual(len(preview['action_digest']), 64)
            self.assertTrue(b.ctx.non_interactive)
            with self.assertRaises(Exception):
                with b.ctx.store.connection() as conn:
                    conn.execute('DELETE FROM permits')
        self.assertEqual(snapshot(), before)
        with self.b.open():
            with self.assertRaises(ValueError):
                self.b.approval('research', request, '0' * 64)
            changed = {**request, 'rounds': 1}
            with self.assertRaises(ValueError):
                self.b.approval('research', changed, preview['action_digest'])
            self.assertEqual(self.b.permits()['permits'], [])
            grant = self.b.approval('research', request, preview['action_digest'])
            self.assertEqual(grant.status, 'ok', grant)
            self.assertTrue(self.b.ctx.non_interactive)
            replay = self.b.approval('research', request, preview['action_digest'])
            self.assertEqual(replay.status, 'ok', replay)
            for key in ('access_grant_id', 'share_grant_id', 'discussion_id'):
                self.assertEqual(replay.data[key], grant.data[key])
            self.assertTrue(replay.data['replayed'])
            self.assertEqual(len(self.b.permits()['permits']), 2)
            self.assertEqual(self.b.ctx.muse_gateway.calls, [])

    def test_ui_preview_refuses_pending_wal_and_busy_workspace(self):
        request = self.approval_request()
        wal = self.taskroot / 'workspace' / 'state.sqlite3-wal'
        wal.write_bytes(b'pending synthetic WAL')
        wal.chmod(0o600)
        with self.new_bridge().open_preview() as b:
            with self.assertRaisesRegex(ValueError, 'checkpointed'):
                b.approval('research', request)
        self.assertEqual(wal.read_bytes(), b'pending synthetic WAL')
        wal.unlink()
        with bridge.locked(self.taskroot / 'bridge.lock'):
            with self.assertRaises(BlockingIOError):
                with self.new_bridge().open_preview():
                    self.fail('busy workspace must not be previewed')

    def test_ui_core_file_protocol_in_real_offline_sandbox(self):
        # /Users is essential: the profile's private-file boundary applies there.
        with tempfile.TemporaryDirectory(prefix='muse-approval-os-', dir=CORE.parents[3] / '.ai/work') as temporary:
            root = Path(temporary).resolve()
            self.assertIn('/Users/', str(root))
            private, project, inputs = root / 'private', root / 'Product/Synthetic', root / 'inputs'
            for d in (private, project, inputs): d.mkdir(parents=True, mode=0o700)
            taskroot = private / 'projects/Synthetic/task'
            metadata = safety.SecretStore(private / 'auth').put(
                b'{"format":"cookie-header","cookie_header":"synthetic=never-sent"}',
                provider='synthetic', account='synthetic', created_at=datetime.now(timezone.utc).isoformat())
            binding = m.MuseBinding(provider='synthetic', account='synthetic', auth_ref=metadata['auth_ref'])
            config = bridge.Config()
            config.muse.enabled, config.muse.binding = True, binding
            bridge.private_dir(private / 'workspace-muse')
            bridge.save(private / 'workspace-muse/metamuse.toml', bridge.tomlkit.dumps(config.model_dump(exclude_none=True)))
            seed = bridge.Bridge(taskroot, project, inputs, private, 'Synthetic', 'task', binding=binding)
            with seed.open():
                imported = seed.call('metamuse_collect', {'inputs':[{'kind':'text','text':'Synthetic sandbox material'}],
                    'resources':['post'],'limits':{'max_urls':1,'max_items':2,'max_bytes':10000,'wall_clock_seconds':30},
                    'access_grant_id':None,'request_key':'material'}, run=True)
                self.assertEqual(imported.data['job']['state'], 'succeeded', imported)
                found = seed.call('metamuse_search', {'query':'Synthetic'})
                packet = seed.call('metamuse_packet_prepare', {'selection':[r['ref'] for r in found.data['results']], 'request_key':'packet'}).data
            request = {'open_request':{'topic':'Synthetic sandbox topic','request_key':'open'},'packet_id':packet['id'],
                'rounds':1,'max_reads':1,'expires_at':(datetime.now(timezone.utc)+timedelta(minutes=20)).isoformat(),'request_key':'scope'}
            envelope = {'schema':1,'id':'synthetic','project':'Synthetic','task':'task','kind':'research','request':request,
                'continuation':{'role':'司令塔','text':'Synthetic only'},'createdAt':datetime.now(timezone.utc).isoformat()}
            directory = project / '.ai/muse-approvals'
            bridge.private_dir(directory)
            file = directory / 'synthetic.json'; bridge.save(file,json.dumps(envelope))
            bundle = Path(sys.executable).parents[2]
            params = ['-D','bundle='+str(bundle),'-D','bridge='+str(CORE.parent),'-D','private='+str(private),
                '-D','taskroot='+str(taskroot),'-D','taskparent='+str(taskroot.parent),'-D','project='+str(project)]
            def run(operation, digest=None, profile='hub-approval.sb', request_file=file):
                command = ['/usr/bin/sandbox-exec',*params,'-f',str(CORE.parent/profile),str(bundle/'.venv/bin/python'),'-I','-B',str(CORE),
                    '--taskroot',str(taskroot),'--project-dir',str(project),'--inputs',str(inputs),'--legacy',str(private),
                    '--project','Synthetic','--task','task',*(['--checked-digest',digest] if digest else []),operation,str(request_file)]
                return subprocess.run(command,capture_output=True,text=True,timeout=20,env={'PATH':'/usr/bin:/bin','LANG':'en_US.UTF-8'})
            before = {str(p): (p.read_bytes(),p.stat().st_mode,p.stat().st_mtime_ns) for p in private.rglob('*') if p.is_file()}
            denied = run('approval-preview', profile='hub-offline.sb')
            self.assertNotEqual(denied.returncode,0)  # Old profile cannot validate the legacy binding.
            preview = run('approval-preview')
            self.assertEqual(preview.returncode,0,preview.stdout+preview.stderr)
            value = json.loads(preview.stdout)
            self.assertIn('Synthetic sandbox material',value['packet_full_text'])
            after = {str(p): (p.read_bytes(),p.stat().st_mode,p.stat().st_mtime_ns) for p in private.rglob('*') if p.is_file()}
            self.assertEqual(before,after)
            reservation = directory / '.decisions/task/synthetic.json'
            bridge.private_dir(reservation.parent)
            decision = {'schema':1,'project':'Synthetic','task':'task','id':'synthetic',
                'decision':'approve','state':'unknown','digest':value['action_digest'],
                'requestSHA':hashlib.sha256(file.read_bytes()).hexdigest(),'at':datetime.now(timezone.utc).isoformat()}
            marker = taskroot / 'approval-issued-synthetic.json'
            # Direct, non-TTY CLI invocations cannot mint authority just by
            # obtaining a digest. All cases use the real upstream store/profile.
            changes = {'state':{'state':'approved'},'decline':{'decision':'decline'},'grant':{'grant':None},
                'digest':{'digest':'0'*64},'SHA':{'requestSHA':'0'*64},
                'expired':{'at':(datetime.now(timezone.utc)-timedelta(minutes=10)).isoformat()},
                'future':{'at':(datetime.now(timezone.utc)+timedelta(minutes=1)).isoformat()},
                'naive-time':{'at':datetime.now().isoformat()},'project':{'project':'Other'},
                'task':{'task':'other'},'id':{'id':'other'},'schema':{'schema':2}}
            for case in ['missing',*changes,'permissions','linked','hardlink','marker-file','marker-dir','marker-link','wrong-location']:
                with self.subTest(direct_issue=case):
                    if case != 'missing': bridge.save(reservation,json.dumps({**decision,**changes.get(case,{})}))
                    side = root / 'synthetic-reservation-side'
                    if case == 'permissions': reservation.chmod(0o644)
                    if case == 'linked':
                        reservation.rename(side); reservation.symlink_to(side)
                    if case == 'hardlink': os.link(reservation,side)
                    if case == 'marker-file': bridge.save(marker,'{}')
                    if case == 'marker-dir': marker.mkdir(mode=0o700)
                    if case == 'marker-link': marker.symlink_to(reservation)
                    wrong = project / 'synthetic.json'
                    if case == 'wrong-location': bridge.save(wrong,file.read_text())
                    rejected = run('approval-issue',value['action_digest'],request_file=wrong if case == 'wrong-location' else file)
                    self.assertNotEqual(rejected.returncode,0,rejected.stdout+rejected.stderr)
                    with seed.open_preview(): self.assertEqual(seed.permits()['permits'],[])
                    if case.startswith('marker-'):
                        marker.rmdir() if marker.is_dir() else marker.unlink()
                    else: self.assertFalse(os.path.lexists(marker))
                    if os.path.lexists(reservation): reservation.unlink()
                    if side.exists(): side.unlink()
                    if wrong.exists(): wrong.unlink()
            bridge.save(reservation,json.dumps(decision))
            issued = run('approval-issue',value['action_digest'])
            self.assertEqual(issued.returncode,0,issued.stdout+issued.stderr)
            self.assertEqual(json.loads(issued.stdout)['status'],'ok')
            self.assertEqual(marker.stat().st_mode & 0o777,0o600)
            self.assertEqual(json.loads(marker.read_text())['requestSHA'],decision['requestSHA'])
            # Even the unchanged still-unknown reservation cannot be used twice.
            self.assertNotEqual(run('approval-issue',value['action_digest']).returncode,0)
            self.assertNotIn('never-sent',preview.stdout+issued.stdout)
            network = subprocess.run(['/usr/bin/sandbox-exec',*params,'-f',str(CORE.parent/'hub-approval.sb'),
                str(bundle/'.venv/bin/python'),'-I','-B','-c',
                "import socket; s=socket.socket(); s.connect(('127.0.0.1',9))"],capture_output=True,text=True)
            self.assertIn('Operation not permitted',network.stderr)
            with seed.open(): self.assertEqual(len(seed.permits()['permits']),2)

            # Drive the real Hub decide service, not the HTTP decision endpoint.
            # Node and the core are separate OS-sandboxed children: stdio brokers
            # the helper calls so macOS never has to nest sandbox_apply().
            example = directory / 'example.json'
            permit = {**envelope,'id':'example','kind':'permit','request':{
                'operation':'muse.open','request':{'project_id':seed.project_id,'topic':'One synthetic permit','request_key':'decide-open'},
                'expires_at':request['expires_at'],'request_key':'decide-permit','max_uses':1}}
            bridge.save(example,json.dumps(permit))
            script = r"""
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {MuseApprovals}=require(process.argv[1]);
const lines=require('node:readline').createInterface({input:process.stdin});
let answer,dispatches=0;
lines.on('line',line=>{const v=JSON.parse(line);const done=answer;answer=null;done(v);});
const helper=(operation,file,digest)=>new Promise(resolve=>{answer=resolve;console.log(JSON.stringify({operation,file,digest}));});
const root=process.argv[2],dir=path.join(root,'Product/Synthetic/.ai/muse-approvals');
const muse={root,workspace:(p,t)=>{assert.equal(p,'Synthetic');assert.equal(t,'task');},
 approvalPreview:async(p,t,file)=>helper('approval-preview',file),
 approvalIssue:async(p,t,file,digest)=>{const r=await helper('approval-issue',file,digest);assert.equal(r.status,'ok');return r.data;}};
const service=new MuseApprovals({muse,probe:()=>{},dispatch:async request=>{
 dispatches++;assert.equal(request.requestKey,'muse-approval:example');
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'.decisions/task/example.json'))).stage,'continuation');return {ok:true};}});
(async()=>{const row=(await service.list('Synthetic','task')).approvals.find(r=>r.id==='example');
 const body={project:'Synthetic',task:'task',id:'example',ticket:row.ticket,decision:'approve',confirm:true};
 const result=await service.decide(body);assert.equal(result.state,'accepted');
 await assert.rejects(service.decide(body));assert.equal(dispatches,1);
 console.log(JSON.stringify({done:true,result,dispatches}));lines.close();
})().catch(error=>{console.log(JSON.stringify({error:error.message}));process.exitCode=1;lines.close();});
"""
            node = subprocess.Popen(['/usr/bin/sandbox-exec','-p','(version 1)(allow default)(deny network*)',
                shutil.which('node'),'-e',script,str(CORE.parents[1]/'muse-approvals.js'),str(root)],
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,
                env={'PATH':'/usr/bin:/bin','LANG':'en_US.UTF-8'})
            try:
                operations = []
                while True:
                    self.assertTrue(select.select([node.stdout],[],[],20)[0],'synthetic decide timed out')
                    line = node.stdout.readline()
                    self.assertTrue(line,'synthetic decide exited early')
                    call = json.loads(line)
                    self.assertNotIn('error',call,call)
                    if call.get('done'):
                        self.assertEqual(call['dispatches'],1)
                        break
                    self.assertIn(call['operation'],('approval-preview','approval-issue'))
                    self.assertEqual(Path(call['file']),example)
                    operations.append(call['operation'])
                    result = run(call['operation'],call.get('digest'),request_file=example)
                    self.assertEqual(result.returncode,0,result.stdout+result.stderr)
                    node.stdin.write(result.stdout.strip()+'\n'); node.stdin.flush()
                self.assertEqual(node.wait(timeout=10),0,node.stderr.read())
                self.assertEqual(operations,['approval-preview','approval-issue'])
                with seed.open_preview(): self.assertEqual(len(seed.permits()['permits']),3)
                self.assertEqual(json.loads((directory/'.decisions/task/example.json').read_text())['state'],'accepted')
                self.assertTrue((taskroot/'approval-issued-example.json').exists())
            finally:
                if node.poll() is None: node.kill(); node.wait()
                for stream in (node.stdin,node.stdout,node.stderr): stream.close()

    def test_ui_issue_marker_survives_upstream_rejection_and_prevents_retry(self):
        request = self.approval_request()
        directory = self.project / '.ai/muse-approvals'
        bridge.private_dir(directory / '.decisions/task')
        file = directory / 'rejected.json'
        bridge.save(file,json.dumps({'schema':1,'id':'rejected','project':'Synthetic','task':'task',
            'kind':'research','request':request}))
        # A matching reservation is necessary, but it never replaces the
        # upstream recomputation. A wrong upstream digest still burns the ID.
        bridge.save(directory/'.decisions/task/rejected.json',json.dumps({'schema':1,'project':'Synthetic','task':'task',
            'id':'rejected','decision':'approve','state':'unknown','digest':'0'*64,
            'requestSHA':hashlib.sha256(file.read_bytes()).hexdigest(),'at':datetime.now(timezone.utc).isoformat()}))
        with self.b.open():
            with self.assertRaisesRegex(ValueError,'approval changed'):
                self.b.approval_file(file,'0'*64)
            marker = self.taskroot / 'approval-issued-rejected.json'
            self.assertTrue(marker.exists())
            with self.assertRaises(FileExistsError): self.b.approval_file(file,'0'*64)
            self.assertEqual(self.b.permits()['permits'],[])

    def test_ui_control_operations_are_absent_from_ai_mcp_and_require_checked_digest(self):
        for name in ('hub_launcher', 'hub_mcp'):
            spec = importlib.util.spec_from_file_location('approval_test_' + name, CORE.with_name(name + '.py'))
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            if name == 'hub_launcher':
                for flags in (['approval-issue','file.json'], ['--run','approval-preview','file.json'],
                              ['--checked-digest','a'*64,'approval-preview','file.json']):
                    with patch.object(sys, 'argv', ['launcher','--bundle','unused','--project','Synthetic','--task','task',*flags]):
                        with self.assertRaises(ValueError): module.main()
            else:
                dispatcher = module.Dispatcher('/unused','/unused','Synthetic','task',self.taskroot)
                for operation in ('approval-preview','approval-issue'):
                    self.assertEqual(dispatcher.call(operation,{})['status'],'stopped')
                self.assertFalse(self.taskroot.exists())
        self.assertNotIn('approval-issue',m.TOOL_REQUEST_MODELS)

    def test_ui_approval_profile_preserves_file_and_network_boundaries(self):
        with tempfile.TemporaryDirectory(prefix='muse-approval-boundary-', dir=CORE.parents[3] / '.ai/work') as temporary:
            root = Path(temporary).resolve()
            private, project = root/'private', root/'project'
            taskroot = private/'projects/Synthetic/task'
            for d in (project,private/'auth',taskroot/'credential-intake'): d.mkdir(parents=True,mode=0o700)
            auth, intake, outside = private/'auth/synthetic.json',taskroot/'credential-intake/synthetic.json',root/'outside.txt'
            for f in (auth,intake,outside): bridge.save(f,'synthetic')
            bundle = Path(sys.executable).parents[2]
            probe = """import pathlib,socket,sys
assert pathlib.Path(sys.argv[1]).read_text()=='synthetic'
for f in sys.argv[2:4]:
 try: pathlib.Path(f).read_text()
 except PermissionError: pass
 else: raise AssertionError('unexpected read')
try: pathlib.Path(sys.argv[1]).write_text('changed')
except PermissionError: pass
else: raise AssertionError('legacy auth write')
try: socket.socket().connect(('127.0.0.1',9))
except PermissionError: pass
else: raise AssertionError('network')
print('boundaries preserved')
"""
            params = ['-D','bundle='+str(bundle),'-D','bridge='+str(CORE.parent),'-D','private='+str(private),
                '-D','taskroot='+str(taskroot),'-D','taskparent='+str(taskroot.parent),'-D','project='+str(project)]
            result = subprocess.run(['/usr/bin/sandbox-exec',*params,'-f',str(CORE.parent/'hub-approval.sb'),
                str(bundle/'.venv/bin/python'),'-I','-B','-c',probe,str(auth),str(intake),str(outside)],
                capture_output=True,text=True,env={'PATH':'/usr/bin:/bin','LANG':'en_US.UTF-8'})
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(auth.read_text(),'synthetic')

    def test_ui_permit_expiry_task_and_budgets_are_bound(self):
        self.approval_request()
        with self.b.open():
            request = {'operation': 'muse.open', 'request': {'project_id': self.b.project_id,
                        'topic': 'Synthetic workshop', 'request_key': 'single-open'},
                        'expires_at': (datetime.now(timezone.utc) + timedelta(minutes=20)).isoformat(),
                        'max_uses': 1, 'request_key': 'single-grant'}
            preview = self.b.approval('permit', request)
            with self.assertRaises(ValueError):
                self.b.approval('permit', {**request, 'max_uses': 2}, preview['action_digest'])
            with self.assertRaises(ValueError):
                self.b.approval('permit', {**request, 'expires_at': '2000-01-01T00:00:00+00:00'})
            with self.assertRaises(Exception):
                self.b.approval('permit', {**request, 'request': {**request['request'], 'project_id': 'prj_other'}})
            self.assertEqual(self.b.permits()['permits'], [])
            result = self.b.approval('permit', request, preview['action_digest'])
            self.assertEqual(result.status, 'ok', result)
            self.assertEqual(len(self.b.permits()['permits']), 1)
            self.assertTrue(self.b.ctx.non_interactive)
            with self.assertRaises(ValueError):
                self.b.call('approval-issue', {})
            self.assertEqual(self.b.ctx.muse_gateway.calls, [])

    def test_ui_collection_previews_keep_allowlists_without_writing_config(self):
        from metamuse import config as config_module, remote_media
        from metamuse.config import RemoteApproval
        self.approval_request()
        with self.b.open():
            config = bridge.load_config(self.b.ctx.paths.root)
            config.remote_media.approvals = [RemoteApproval(extractor='Synthetic', hosts=['media.fixture.test'])]
            config.facebook.enabled, config.facebook.account = True, 'fixture'
            config.facebook.auth_ref = 'secret_synthetic'
            config.facebook.approved_page_types = ['post_permalink']
            self.b.write_config(config)
        config_file = self.taskroot / 'workspace/metamuse.toml'
        before = config_file.read_bytes()
        original = config_module.load_config
        base = {'project_id':self.b.project_id,'limits':{'max_urls':1,'max_items':2,'max_bytes':10000,'wall_clock_seconds':30},
                'access_grant_id':None,'request_key':'synthetic-collect'}
        video = {**base,'inputs':[{'kind':'url','url':'https://media.fixture.test/video'}],'resources':['media_metadata']}
        facebook = {**base,'inputs':[{'kind':'url','url':'https://www.facebook.com/synth.lab/posts/pfbid0101synth'}],'resources':['post']}
        expiry = (datetime.now(timezone.utc)+timedelta(minutes=20)).isoformat()
        class Extractor:
            @classmethod
            def ie_key(cls): return 'Synthetic'
        with self.new_bridge().open_preview() as b, contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(remote_media,'dependency_available',return_value=True))
            stack.enter_context(patch.object(remote_media,'_require_reviewable_url',side_effect=lambda url:url))
            stack.enter_context(patch.object(remote_media,'_select',side_effect=lambda url,approvals:(Extractor,approvals[0])))
            for inner in (video,facebook):
                preview = b.approval('permit',{'operation':'collect.remote','request':inner,'expires_at':expiry,'request_key':'grant','max_uses':1})
                self.assertIn(inner['inputs'][0]['url'],preview['destination'])
                self.assertEqual(config_module.load_config,original)
            self.assertEqual(b.permits()['permits'],[])
        self.assertEqual(config_file.read_bytes(),before)
        with self.b.open():
            config = bridge.load_config(self.b.ctx.paths.root)
            config.remote_media.approvals = []
            self.b.write_config(config)
            with patch.object(remote_media,'dependency_available',return_value=True), patch.object(remote_media,'_require_reviewable_url',side_effect=lambda url:url):
                with self.assertRaises(m.CoreError):
                    self.b.approval('permit',{'operation':'collect.remote','request':video,'expires_at':expiry,'request_key':'denied','max_uses':1})
            self.assertEqual(config_module.load_config,original)
            self.assertEqual(self.b.permits()['permits'],[])

    def test_two_rounds_restart_revision_and_export(self):
        with self.b.open():
            pkt = self.packet()
            denied = self.b.call('metamuse_muse_open', {'topic': 'Synthetic workshop', 'request_key': 'open'})
            self.assertNotEqual(denied.status, 'accepted')
            self.assertIsNotNone(denied.error)
            opening, grants = self.approve_fixture(pkt)
            opened = self.call('muse_open', {**opening, 'access_grant_id': grants['access_grant_id']}, True)
            self.assertEqual(opened.data['job']['state'], 'succeeded', opened)
            first_id = self.b.project_id
        self.b = self.new_bridge()
        with self.b.open():
            self.assertEqual(first_id, self.b.project_id)
            observations = []
            for index in range(2):
                sent = self.call('muse_send', {'discussion_id': grants['discussion_id'], 'packet_id': pkt['id'],
                    'question': 'Which facts are supported?' if index == 0 else 'Which gaps remain?',
                    'share_grant_id': grants['share_grant_id'], 'request_key': 'question-' + str(index)}, True)
                self.assertEqual(sent.data['job']['state'], 'succeeded', sent)
                exchange = sent.data['exchange_id']
                refresh = self.call('muse_read', {'exchange_id': exchange, 'refresh': True,
                                    'access_grant_id': grants['access_grant_id']}, True)
                self.assertEqual(refresh.data['job']['state'], 'succeeded', refresh)
                read = self.call('muse_read', {'exchange_id': exchange})
                observations.extend(x['evidence_ref'] for x in read.data['observations'])
                self.call('muse_close_exchange', {'exchange_id': exchange, 'outcome': 'answered', 'request_key': 'close-' + str(index)})
            self.assertTrue(self.b.history()['discussions'])
            draft = self.call('draft_save', {'text': 'Synthetic supported proposal', 'platform': 'generic',
                'facts_refs': [*pkt['selection'], *observations], 'request_key': 'draft'}).data
            revision = self.call('draft_save', {'text': 'Synthetic revised proposal', 'platform': 'generic',
                'draft_id': draft['draft_id'], 'expected_revision': 1, 'facts_refs': pkt['selection'], 'request_key': 'revision'}).data
            self.assertEqual(revision['revision'], 2)
            stale = self.b.call('metamuse_draft_save', {'text': 'stale', 'platform': 'generic', 'draft_id': draft['draft_id'],
                        'expected_revision': 1, 'facts_refs': [], 'request_key': 'stale'})
            self.assertNotEqual(stale.status, 'ok')
            self.call('draft_preview', {'draft_id': draft['draft_id'], 'revision': 2})
            for fmt in ('text', 'markdown', 'jsonl', 'csv'):
                export = self.call('export', {'selection': [{'kind': 'draft_revision', 'id': draft['draft_id'], 'revision': 2}],
                                            'format': fmt, 'request_key': 'export-' + fmt}, True)
                self.assertEqual(export.data['state'], 'ready', export)
                self.assertTrue((self.b.ctx.paths.root / export.data['artifact'] / 'manifest.json').is_file())
            self.assertEqual(len(self.b.history()['exchanges']), 2)
            count = len(self.b.ctx.muse_gateway.calls)
            with self.assertRaises(ValueError):
                self.call('muse_send', {'discussion_id': grants['discussion_id'], 'packet_id': pkt['id'],
                    'question': 'Outside approved two rounds', 'share_grant_id': grants['share_grant_id'], 'request_key': 'third'}, True)
            self.assertEqual(count, len(self.b.ctx.muse_gateway.calls))
        self.assertIn('network_mode = "offline"', (self.taskroot / 'workspace/metamuse.toml').read_text())

    def test_paths_schemas_and_human_boundary(self):
        allowed = self.inputs / 'request.json'
        allowed.write_text('{}')
        outside = self.root / 'outside.json'
        outside.write_text('{}')
        link = self.inputs / 'link.json'
        link.symlink_to(outside)
        with self.b.open():
            self.assertEqual(self.b.request(allowed), {})
            for path in (outside, link):
                with self.assertRaises(ValueError):
                    self.b.request(path)
            allowed.write_text('{"query":"a","query":"b"}')
            with self.assertRaises(ValueError):
                self.b.request(allowed)
            with self.assertRaises(ValueError):
                self.b.normalize('metamuse_search', {'query': 'a', 'cookie': 'never-accepted'})
            with self.assertRaises(ValueError):
                self.b.normalize('metamuse_search', {'project_id': 'other', 'query': 'a'})
            with self.assertRaises(ValueError):
                self.b.normalize('metamuse_collect', {'inputs': [{'kind': 'url', 'url': 'https://example.com'}]})
            with self.assertRaises(ValueError):
                self.b.normalize('metamuse_job_control', {'operation': 'cancel', 'job_id': 'job', 'request_key': 'cancel'})
            with self.assertRaises(ValueError):
                self.b.human()
            with self.assertRaises(Exception):
                self.b.call('metamuse_muse_open', {'topic': 'a', 'access_grant_id': 'unissued', 'request_key': 'open'})

    def test_lock_configuration_restore_and_secret_projection(self):
        with self.b.open():
            other = self.new_bridge()
            with self.assertRaises(BlockingIOError):
                with other.open():
                    pass
            with self.assertRaises(ValueError):
                self.b.call('metamuse_search', {'query': 'a'}, online=True)
        with self.assertRaises(RuntimeError):
            with self.b.open():
                raise RuntimeError('synthetic interruption')
        self.assertIn('network_mode = "offline"', (self.taskroot / 'workspace/metamuse.toml').read_text())
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            bridge.emit({'auth_ref': 'SECRET', 'cookie': 'SECRET', 'text': 'untrusted\x1b[2J\u202e', 'nested': {'access_token': 'SECRET'}})
        self.assertNotIn('SECRET', captured.getvalue())
        self.assertNotIn('\x1b', captured.getvalue())
        self.assertNotIn('\u202e', captured.getvalue())

    def test_queue_is_not_drained_and_no_worker_is_required(self):
        with self.b.open():
            request = {'inputs': [{'kind': 'text', 'text': 'queued synthetic'}], 'resources': ['post'],
                'limits': {'max_urls': 1, 'max_items': 2, 'max_bytes': 10000, 'wall_clock_seconds': 30},
                'access_grant_id': None, 'request_key': 'one'}
            one = self.call('collect', request)
            self.assertFalse(one.data['worker_available'])
            two = self.call('collect', {**request, 'request_key': 'two'})
            with self.assertRaises(ValueError):
                self.b.run_job(two.data['job_id'])
            self.assertEqual(self.call('job_get', {'job_id': one.data['job_id']}).data['job']['state'], 'queued')

    def test_expired_and_revoked_grants_stop_before_gateway(self):
        with self.b.open():
            pkt = self.packet()
            opening, grants = self.approve_fixture(pkt)
            class Future(datetime):
                @classmethod
                def now(cls, tz=None):
                    return datetime.now(tz) + timedelta(days=1)
            with patch.object(bridge, 'datetime', Future):
                with self.assertRaises(ValueError):
                    self.call('muse_open', {**opening, 'access_grant_id': grants['access_grant_id']}, True)
            self.b.ctx.non_interactive = False
            safety.revoke_permit(self.b.ctx, grants['share_grant_id'], request_key='revoke')
            self.b.ctx.non_interactive = True
            with self.assertRaises(ValueError):
                self.b.live_grant('metamuse_muse_send', {'share_grant_id': grants['share_grant_id']})
            self.assertEqual(self.b.ctx.muse_gateway.calls, [])

    def test_unknown_open_is_not_resumed_or_sent_twice(self):
        with self.b.open():
            pkt = self.packet()
            opening, grants = self.approve_fixture(pkt)
            self.b.ctx.muse_gateway.mode = 'open_timeout'
            request = {**opening, 'access_grant_id': grants['access_grant_id']}
            result = self.call('muse_open', request, True)
            self.assertEqual(result.data['job']['state'], 'awaiting_user')
            count = len(self.b.ctx.muse_gateway.calls)
            replay = self.b.call('metamuse_muse_open', request, run=True)
            self.assertEqual(replay.status, 'error')
            self.assertEqual(replay.error.code.value, 'E_EXTERNAL_STATE_UNKNOWN')
            self.assertEqual(count, len(self.b.ctx.muse_gateway.calls))
            with self.assertRaises(ValueError):
                self.call('job_control', {'job_id': result.data['job_id'], 'operation': 'resume', 'request_key': 'resume'}, True)

    def test_initialization_failure_restores_offline_and_new_private_root(self):
        parent = self.root / 'support'
        parent.mkdir(mode=0o755)
        fresh = parent / 'fresh-private'
        bridge.private_dir(fresh / 'projects' / 'Synthetic' / 'task')
        self.assertEqual(fresh.stat().st_mode & 0o777, 0o700)
        with patch.object(bridge.app, 'create_project', side_effect=RuntimeError('synthetic initialization failure')):
            with self.assertRaises(RuntimeError):
                with self.b.open(online=True):
                    self.fail('failed initialization must not yield')
        config = bridge.load_config(self.taskroot / 'workspace')
        self.assertEqual(config.app.network_mode, 'offline')
        self.assertIsNone(self.b.ctx)

    def human_answers(self, answers):
        master, slave = pty.openpty()
        sys.stdout.flush()
        pid = os.fork()
        if pid == 0:
            try:
                os.close(master)
                for fd in (0, 1, 2):
                    os.dup2(slave, fd)
                os.close(slave)
                iterator = iter(answers)
                result = self.b.human(lambda _: next(iterator))
                bridge.emit(result)
                sys.stdout.flush()
                os._exit(0)
            except BaseException:
                os._exit(2)
        os.close(slave)
        output = b''
        while True:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
        os.close(master)
        _, status = os.waitpid(pid, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 0, output.decode(errors='replace'))
        lines = [json.loads(x) for x in output.decode().splitlines() if x.startswith('{')]
        return lines, output.decode()

    def test_human_exact_digest_cancel_and_private_auth(self):
        with self.b.open():
            pkt = self.packet()
            opening = {'topic': 'Synthetic workshop', 'request_key': 'open'}
            request = {'open_request': opening, 'packet_id': pkt['id'], 'rounds': 2, 'max_reads': 3,
                       'expires_at': (datetime.now(timezone.utc) + timedelta(minutes=20)).isoformat(), 'request_key': 'human-research'}
            path = self.inputs / 'approval.json'
            path.write_text(json.dumps(request))
            lines, text = self.human_answers(['1', str(path), 'wrong digest'])
            self.assertTrue(lines[-1]['cancelled'])
            self.assertEqual(self.b.permits()['permits'], [])
            digest = lines[0]['approval']['action_digest']
            lines, text = self.human_answers(['1', str(path), digest])
            self.assertEqual(lines[-1]['status'], 'ok')
            self.assertEqual(len(self.b.permits()['permits']), 2)
            self.assertIn('Synthetic workshop had twelve seats', text)
            credential = self.taskroot / 'credential-intake/page-token.txt'
            credential.write_text('synthetic-fixture-page-token')
            credential.chmod(0o600)
            lines, text = self.human_answers(['8', 'publishing', 'fixture-page', str(credential), '12345', 'v25.0', 'CONNECT'])
            self.assertTrue(lines[-1]['data']['configured'])
            self.assertNotIn('synthetic-fixture-page-token', text)
            lines, text = self.human_answers(['6'])
            ref = lines[-1]['credentials'][0]['credential_id']
            self.assertNotIn('synthetic-fixture-page-token', text)
            lines, _ = self.human_answers(['7', ref, 'REVOKE'])
            self.assertTrue(lines[-1]['data']['revoked'])
            self.assertFalse((self.taskroot / 'auth' / (ref + '.json')).exists())
            self.assertFalse((self.legacy / 'auth').exists())
            # Cancellation is separate from AI resume and leaves an audit receipt.
            pending = self.call('collect', {'inputs': [{'kind': 'text', 'text': 'cancel synthetic'}], 'resources': ['post'],
                'limits': {'max_urls': 1, 'max_items': 2, 'max_bytes': 10000, 'wall_clock_seconds': 30},
                'access_grant_id': None, 'request_key': 'cancel-source'})
            lines, _ = self.human_answers(['5', pending.data['job_id'], 'CANCEL'])
            self.assertEqual(lines[-1]['data']['state'], 'cancelled')
            resumed = self.call('job_control', {'job_id': pending.data['job_id'], 'operation': 'resume', 'request_key': 'resume-local'}, True)
            self.assertEqual(resumed.data['job']['state'], 'succeeded')


if __name__ == '__main__':
    unittest.main(verbosity=2)

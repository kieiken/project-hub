"""Human-composed direct turn; never exposed as an AI/MCP tool.

All grants still use upstream exact previews and the existing durable M1 gate.
Only explicit inline material is collected; workspace search is never used.
"""
from datetime import datetime, timezone
import json
import hashlib
import re
import time
import contextlib
import signal


@contextlib.contextmanager
def deadline(seconds=90):
    """Bound even a blocking transport call, leaving time for bridge cleanup."""
    def expired(*_):
        raise TimeoutError('direct receive deadline')
    old = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield time.monotonic() + seconds
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)


def validate(b, envelope):
    if envelope.get('schema') != 1 or envelope.get('project') != b.project or envelope.get('task') != b.task:
        raise ValueError('direct task context')
    r = envelope.get('request')
    if envelope.get('kind') != 'direct' or not isinstance(r, dict) or set(r) != {'question', 'materials', 'expires_at', 'request_key'}:
        raise ValueError('direct schema')
    if r['request_key'] != envelope.get('id') or not re.fullmatch(r'direct_[a-f0-9-]{36}', r['request_key']):
        raise ValueError('direct identity')
    q = r['question']
    if not isinstance(q, str) or not q.strip() or len(q.encode()) > 8192:
        raise ValueError('question must be 1 to 8192 UTF-8 bytes')
    if not isinstance(r['materials'], list) or len(r['materials']) > 10:
        raise ValueError('materials')
    size = 0
    for item in r['materials']:
        if not isinstance(item, dict) or set(item) != {'name', 'text'} or not all(isinstance(v, str) for v in item.values()):
            raise ValueError('material schema')
        if not item['name'] or len(item['name']) > 240 or not item['text'].strip():
            raise ValueError('material text')
        size += len((item['name'] + item['text']).encode())
    if size > 24000:
        raise ValueError('materials exceed 24000 UTF-8 bytes')
    expiry = datetime.fromisoformat(r['expires_at'].replace('Z', '+00:00'))
    if expiry.tzinfo is None or not 0 < (expiry - datetime.now(timezone.utc)).total_seconds() <= 600:
        raise ValueError('expired direct turn')
    from metamuse._muse_lifecycle import _check_question
    _check_question(q)
    if not b.binding and not b.fixture:
        raise ValueError('Muse is not configured')
    return r


def execute(b, envelope):
    progress = {'phase': 'prepare', 'open_confirmed': False, 'send_started': False}
    try:
        with deadline() as end:
            progress['deadline'] = end
            return _execute(b, envelope, progress)
    except Exception:
        # Never persist upstream exceptions, packets, cookies or transport data.
        # A local rejection is distinct from an uncertain send, but does not
        # itself authorize recovery: inspect_unsent must still prove it.
        if progress.get('sent'):
            return progress['sent']
        return {'status': 'unknown' if progress['send_started'] else 'rejected',
                'diagnostic': {'code': 'send_uncertain' if progress['send_started'] else 'before_send_rejected',
                               'phase': progress['phase'], 'open_confirmed': progress['open_confirmed']}}


def _execute(b, envelope, progress):
    from metamuse import models as m
    # Imported here so all validation/redaction/path checks remain shared with Bridge.
    r = validate(b, envelope)
    key = r['request_key']

    call, grant = operations(b, r)

    # One local import per explicit text; exact refs come solely from this job's
    # report, including unchanged rows. Never search old materials by keyword.
    texts = [{'name': '今回の質問', 'text': r['question']}, *r['materials']]
    inputs = [{'kind': 'text', 'text': x['name'] + '\n' + x['text']} for x in texts]
    imported = call('collect', {'inputs': inputs, 'resources': ['post'],
        'limits': {'max_urls': len(inputs), 'max_items': 20, 'max_bytes': 40000, 'wall_clock_seconds': 30},
        'access_grant_id': None, 'request_key': key + '-collect'})
    refs = []
    for step in imported['job']['result']['data']['steps']:
        for row in step['data']['rows']:
            if row['status'] not in ('committed', 'unchanged') or not row.get('item_id') or not row.get('revision'):
                raise ValueError('direct material import incomplete')
            ref = {'kind': 'item_revision', 'id': row['item_id'], 'revision': row['revision']}
            if ref not in refs:
                refs.append(ref)
    if not refs:
        raise ValueError('no direct material')
    pkt = call('packet_prepare', {'selection': refs, 'request_key': key + '-packet'})
    packet = b.ctx.store.get(m.Packet, pkt['id'])
    if len(packet.rendered_text.encode()) > min(49152, b.ctx.limits.packet_max_utf8_bytes):
        raise ValueError('direct packet exceeds limit')
    # Resolve/freeze full packet and check redactions before any remote open.
    from metamuse.safety import redact_text
    if redact_text(packet.rendered_text)[0] != packet.rendered_text:
        raise ValueError('direct material requires redaction; send was not started')
    session = b.root / 'inputs' / 'direct-chat-session.json'
    discussion = None
    if session.exists():
        state = b.request(session, private=True)
        if set(state) not in ({'project', 'task', 'discussion_id'}, {'project', 'task', 'discussion_id', 'exchange_id'}) or state['project'] != b.project or state['task'] != b.task:
            raise ValueError('direct session context')
        discussion = state['discussion_id']
        if b.ctx.store.get(m.Discussion, discussion).project_id != b.project_id:
            raise ValueError('direct session project')
        progress['open_confirmed'] = True
        progress['phase'] = 'send_prepare'
        with b.ctx.store.connection() as conn:
            count = conn.execute('SELECT COUNT(*) FROM exchanges WHERE discussion_id=?', (discussion,)).fetchone()[0]
        if count >= b.ctx.limits.max_exchanges:
            # No history refresh, previous close, or share permit has occurred.
            # This fixed terminal diagnosis is safe to release without recovery.
            return {'status': 'not-sent', 'diagnostic': {'code': 'exchange_limit',
                    'phase': 'send_prepare', 'open_confirmed': True}}
        if state.get('exchange_id'):
            exchange = b.ctx.store.get(m.Exchange, state['exchange_id'])
            if exchange.project_id != b.project_id or exchange.discussion_id != discussion:
                raise ValueError('previous exchange context')
            previous = call('muse_read', {'exchange_id': state['exchange_id']})
            if previous['discussion_id'] != discussion or not any(x.get('role') == 'assistant' and x.get('text') for x in previous['messages']):
                raise ValueError('previous exchange requires reconciliation')
            # A new human follow-up explicitly requests more information. Record
            # that host outcome, never claim semantic completion. Upstream still
            # rejects uncertain delivery and quarantined sessions.
            if exchange.state == 'closed':
                if exchange.outcome not in ('needs_more_data', 'answered'):
                    raise ValueError('previous exchange requires reconciliation')
            else:
                call('muse_close_exchange', {'exchange_id': state['exchange_id'], 'outcome': 'needs_more_data', 'request_key': key + '-followup'})

    if not discussion:
        progress['phase'] = 'open'
        opening = {'project_id': b.project_id, 'topic': r['question'], 'request_key': key + '-open'}
        access = grant('muse.open', opening, 'open-grant')
        opened = call('muse_open', {**opening, 'access_grant_id': access}, True)
        discussion = opened['discussion_id']
        # save() belongs to the loaded bridge module, not a second imported instance.
        b.save_private(session, json.dumps({'project': b.project, 'task': b.task, 'discussion_id': discussion}) + '\n')
    progress['open_confirmed'] = True
    progress['phase'] = 'history'
    # Existing-discussion muse_open is upstream's authorized history operation.
    # A live send preview requires this baseline; fixture's exemption must never
    # substitute for the same contract. Follow-ups refresh the same session too.
    history = {'project_id': b.project_id, 'discussion_id': discussion,
               'topic': b.ctx.store.get(m.Discussion, discussion).topic,
               'request_key': key + '-history'}
    # Upstream's muse.open preview with discussion_id issues a muse.read permit
    # (permit_operation), rather than accepting a MuseReadRequest without an exchange.
    access = grant('muse.open', history, 'history-grant')
    call('muse_open', {**history, 'access_grant_id': access}, True)
    progress['phase'] = 'send_prepare'
    sending = {'discussion_id': discussion, 'packet_id': pkt['id'], 'question': r['question'], 'request_key': key + '-send'}
    share = grant('muse.send', sending, 'send-grant')
    progress['phase'] = 'send'
    progress['send_started'] = True
    sent = call('muse_send', {**sending, 'share_grant_id': share}, True)
    progress['sent'] = {'status':'sent', 'discussion_id':discussion,
                        'exchange_id':sent['exchange_id'], 'completion_verified':False}
    # Persist the confirmed remote identity before waiting. A slow answer is
    # still a sent question, never an ambiguous send that should be repeated.
    b.save_private(session, json.dumps({'project': b.project, 'task': b.task,
                   'discussion_id': discussion, 'exchange_id': sent['exchange_id']}) + '\n')
    return receive(b, r, discussion, sent['exchange_id'], call, grant,
                   end=progress['deadline'], attempts=2)


def operations(b, r):
    key = r['request_key']
    def call(tool, request, remote=False):
        result = b.call('metamuse_' + tool, request, run=True, online=remote and not b.fixture)
        if result.status not in ('ok', 'accepted') or (result.data or {}).get('job', {}).get('state', 'succeeded') != 'succeeded':
            raise ValueError('direct ' + tool + ' stopped: ' + str(result.status) + '/' + str((result.data or {}).get('job', {}).get('state')) + '/' + str(result.error.message if result.error else '') + '; do not retry')
        if result.next_cursor:
            raise ValueError('pagination requires reconciliation')
        return result.data

    def grant(operation, request, suffix, max_uses=1):
        a = {'operation': operation, 'request': request, 'expires_at': r['expires_at'],
             'request_key': key + '-' + suffix, 'max_uses': max_uses}
        preview = b.approval('permit', a)
        issued = b.approval('permit', a, preview['action_digest'])
        if issued.status != 'ok':
            raise ValueError('direct grant refused')
        return issued.data['id']

    return call, grant


def receive(b, r, discussion, exchange, call, grant, *, end=None, attempts=6, existing=False):
    from metamuse.safety import redact_text
    pending = {'status': 'sent', 'discussion_id': discussion, 'exchange_id': exchange,
               'completion_verified': False}
    # Persist read authority separately from send authority. Later polls reuse
    # this exact permit, never issue another one from the original request.
    statefile = b.root / 'inputs' / ('direct-receive-' + r['request_key'] + '.json')
    state = b.request(statefile, private=True) if existing else {}
    text = state.get('text', '')
    previous = state.get('snapshot')
    try:
        reading = {'exchange_id': exchange, 'refresh': True}
        access = state['permit_id'] if existing else grant('muse.read', reading, 'read-grant', 6)
        state.update(permit_id=access, expires_at=r['expires_at'], discussion_id=discussion, exchange_id=exchange)
        b.save_private(statefile, json.dumps(state) + '\n')
        for attempt in range(attempts):
            # A refresh may use the full 30-second transport timeout. Leave
            # cleanup time rather than starting a job just before SIGALRM.
            if end is not None and time.monotonic() >= end - 35:
                break
            call('muse_read', {**reading, 'access_grant_id': access}, True)
            cached = call('muse_read', {'exchange_id': exchange})
            if cached.get('discussion_id') != discussion or cached.get('next_cursor'):
                raise ValueError('reply identity or pagination requires reconciliation')
            messages = [x for x in cached['messages'] if x.get('role') == 'assistant' and x.get('text')]
            if messages:
                text = '\n\n'.join(x['text'] for x in messages)
                if redact_text(text)[0] != text:
                    raise ValueError('reply requires secret redaction')
                snapshot = [[x.get('id'), x['text']] for x in messages]
                stable = snapshot == previous
                previous = snapshot
                state.update(text=text, snapshot=snapshot)
                b.save_private(statefile, json.dumps(state) + '\n')
                if stable:
                    return {**pending, 'status':'received', 'text':text}
            else:
                previous = None
                state.pop('snapshot', None)
                b.save_private(statefile, json.dumps(state) + '\n')
            if attempt < attempts - 1 and (end is None or time.monotonic() + 12 + 35 < end):
                time.sleep(12)
            else:
                break
    except Exception:
        # Read/permit failures cannot make an acknowledged send unknown. The
        # operator may authorize another read; no send is replayed here.
        pass
    return {**pending, **({'text':text, 'partial':True} if text else {})}


def validate_read(b, envelope):
    from metamuse import models as m
    r = envelope.get('request')
    if (envelope.get('schema') != 1 or envelope.get('project') != b.project or envelope.get('task') != b.task
            or envelope.get('kind') not in ('direct-read', 'direct-poll') or not isinstance(r, dict)
            or set(r) != {'source_id', 'discussion_id', 'exchange_id', 'expires_at', 'request_key'}
            or r['request_key'] != envelope.get('id') or not re.fullmatch(r'read_[a-f0-9-]{36}', str(r['request_key']))
            or not re.fullmatch(r'direct_[a-f0-9-]{36}', str(r['source_id']))):
        raise ValueError('direct read context')
    expiry = datetime.fromisoformat(r['expires_at'].replace('Z', '+00:00'))
    if expiry.tzinfo is None or not 0 < (expiry - datetime.now(timezone.utc)).total_seconds() <= 600:
        raise ValueError('expired direct read')
    directory = b.project_dir / '.ai' / 'muse-approvals'
    source, source_sha = b.request(directory / (r['source_id'] + '.json'), with_sha=True, private=True)
    decision = b.request(directory / '.decisions' / b.task / (r['source_id'] + '.json'), private=True)
    if (source.get('schema') != 1 or source.get('project') != b.project or source.get('task') != b.task
            or source.get('id') != r['source_id'] or source.get('kind') != 'direct'
            or decision.get('schema') != 1 or decision.get('project') != b.project or decision.get('task') != b.task
            or decision.get('id') != r['source_id'] or decision.get('decision') != 'approve' or decision.get('state') not in ('sent','received')
            or decision.get('requestSHA') != source_sha or decision.get('digest') != m.payload_digest(source['request'])
            or any(decision.get('result', {}).get(k) != r[k] for k in ('discussion_id', 'exchange_id'))):
        raise ValueError('read source is not a confirmed pending send')
    state = b.request(b.root / 'inputs' / 'direct-chat-session.json', private=True)
    if (state != {'project': b.project, 'task': b.task, 'discussion_id': r['discussion_id'], 'exchange_id': r['exchange_id']}
            or b.ctx.store.get(m.Discussion, r['discussion_id']).project_id != b.project_id):
        raise ValueError('read session changed')
    previous = b.call('metamuse_muse_read', {'exchange_id': r['exchange_id']})
    if previous.status != 'ok' or previous.data['discussion_id'] != r['discussion_id']:
        raise ValueError('read exchange changed')
    if envelope['kind'] == 'direct-poll':
        original = source['request']
        if r['expires_at'] != original['expires_at']:
            raise ValueError('poll exceeds original authority')
        poll_state = b.request(b.root / 'inputs' / ('direct-receive-' + r['source_id'] + '.json'), private=True)
        permit = b.ctx.store.get(m.Permit, poll_state['permit_id'])
        with b.ctx.store.connection() as conn:
            receipt = conn.execute("SELECT response FROM request_receipts WHERE operation='permit.create' AND request_key=?",
                                   (r['source_id'] + '-read-grant',)).fetchone()
        if (not receipt or json.loads(receipt['response'])['id'] != permit.id
                or any(poll_state.get(k) != r[k] for k in ('discussion_id','exchange_id','expires_at'))
                or permit.project_id != b.project_id or permit.kind != 'access' or permit.revoked
                or permit.max_uses != 6 or permit.used >= 6
                or datetime.fromisoformat(permit.expires_at) != datetime.fromisoformat(r['expires_at'].replace('Z','+00:00'))
                or permit.scope.get('operations') != ['muse.read']):
            raise ValueError('original read permit unavailable')
    return r


def execute_read(b, envelope):
    r = validate_read(b, envelope)
    call, grant = operations(b, r)
    # This path cannot collect/open/send/close. Its only authority is muse.read.
    with deadline() as end:
        if envelope['kind'] == 'direct-poll':
            return receive(b, {**r, 'request_key':r['source_id']}, r['discussion_id'], r['exchange_id'],
                           call, grant, end=end, attempts=1, existing=True)
        return receive(b, r, r['discussion_id'], r['exchange_id'], call, grant, end=end)


def inspect_delivery(b, path):
    """Prefer an acknowledged-send proof, otherwise retain strict unsent proof."""
    try:
        return inspect_sent(b, path)
    except (ValueError, KeyError):
        return inspect_unsent(b, path)


def inspect_sent(b, path):
    from metamuse import models as m, safety
    envelope, request_sha = b.request(path, with_sha=True, private=True)
    key = envelope.get('id')
    directory = b.project_dir / '.ai/muse-approvals'
    if (not isinstance(key, str) or not re.fullmatch(r'direct_[a-f0-9-]{36}', key)
            or path != directory / (key + '.json') or envelope.get('schema') != 1
            or envelope.get('project') != b.project or envelope.get('task') != b.task
            or envelope.get('kind') != 'direct' or envelope.get('request', {}).get('request_key') != key):
        raise ValueError('sent recovery context')
    digest = m.payload_digest(envelope['request'])
    decision, decision_sha = b.request(directory / '.decisions' / b.task / (key + '.json'), with_sha=True, private=True)
    if (any(decision.get(k) != v for k, v in {'schema':1,'project':b.project,'task':b.task,'id':key,
            'decision':'approve','state':'unknown','digest':digest,'requestSHA':request_sha}.items())
            or 'grant' in decision or 'result' in decision):
        raise ValueError('sent recovery decision')
    marker, marker_sha = b.issued_marker(key)
    if marker != {k:decision[k] for k in ('schema','project','task','id','digest','requestSHA','at')}:
        raise ValueError('sent recovery marker')
    session = b.request(b.root / 'inputs/direct-chat-session.json', private=True)
    with b.ctx.store.connection() as conn:
        rows = conn.execute('SELECT id FROM exchanges WHERE request_key=? AND project_id=?', (key + '-send',b.project_id)).fetchall()
        if len(rows) != 1:
            raise ValueError('sent recovery exchange')
        exchange = b.ctx.store.get(m.Exchange, rows[0]['id'], conn=conn)
        discussion = b.ctx.store.get(m.Discussion, exchange.discussion_id, conn=conn)
        proof = exchange.delivery_proof
        if (session != {'project':b.project,'task':b.task,'discussion_id':discussion.id,'exchange_id':exchange.id}
                or exchange.bytes_handed_off is not True or exchange.attempt_verdict != 'acked'
                or exchange.state not in ('sent','reply_observed') or discussion.project_id != b.project_id
                or discussion.state != 'open' or discussion.quarantine_step_id is not None
                or not discussion.remote_session or not proof or proof.kind != 'ack'
                or proof.step_id != exchange.submission_step_id or not exchange.outbound_payload
                or proof.outbound_digest != exchange.outbound_digest
                or exchange.outbound_digest != hashlib.sha256(m.canonical_json(exchange.outbound_payload.body)).hexdigest()
                or exchange.question != envelope['request']['question']):
            raise ValueError('sent recovery acknowledgement')
        if not b.fixture and (discussion.backend != 'live' or not b.binding or
                (discussion.provider,discussion.account,discussion.auth_ref) !=
                (b.binding.provider,b.binding.account,b.binding.auth_ref)):
            raise ValueError('sent recovery binding')
        step = b.ctx.store.get(m.JobStep, exchange.submission_step_id, conn=conn)
        job = b.ctx.store.get(m.Job, exchange.job_id, conn=conn)
        packet = b.ctx.store.get(m.Packet, exchange.packet_id, conn=conn)
        permit = b.ctx.store.get(m.Permit, exchange.permit_id, conn=conn)
        receipt = conn.execute("SELECT response FROM request_receipts WHERE operation='packet.prepare' AND request_key=?", (key+'-packet',)).fetchone()
        if (not receipt or json.loads(receipt['response'])['id'] != packet.id
                or packet.project_id != b.project_id
                or packet.digest != hashlib.sha256(packet.rendered_text.encode()).hexdigest()
                or exchange.digest != m.payload_digest(m.TOOL_REQUEST_MODELS['metamuse_muse_send'].model_validate(job.payload).model_dump(mode='json'))
                or job.project_id != b.project_id or job.operation != 'muse.send' or job.request_key != key+'-send'
                or step.job_id != job.id or step.target != exchange.outbound_payload.target
                or job.payload.get('share_grant_id') != permit.id or job.payload.get('packet_id') != packet.id
                or job.payload.get('question') != exchange.question or job.payload.get('discussion_id') != discussion.id
                or permit.project_id != b.project_id or permit.kind != 'share' or permit.used != 1 or permit.max_uses != 1
                or permit.exact_digest != safety.action_digest(exchange.outbound_payload.target,exchange.outbound_payload.payload)):
            raise ValueError('sent recovery receipt')
    return {'status':'sent','scope':'acknowledged-send','open_confirmed':True,'id':key,
            'project':b.project,'task':b.task,'discussion_id':discussion.id,'exchange_id':exchange.id,
            'requestSHA':request_sha,'decisionSHA':decision_sha,'markerSHA':marker_sha,'digest':digest}


def inspect_unsent(b, path):
    """Local, immutable evidence only; no calls, permits, jobs or secret resolve.

    An acknowledged first open or an exact unused follow-up share permit can
    prove non-delivery. Old request/marker stay burned in both cases.
    """
    from metamuse import models as m
    envelope, request_sha = b.request(path, with_sha=True, private=True)
    key = envelope.get('id')
    directory = b.project_dir / '.ai/muse-approvals'
    if (not isinstance(key, str) or not re.fullmatch(r'direct_[a-f0-9-]{36}', key)
            or path != directory / (key + '.json') or envelope.get('schema') != 1
            or envelope.get('project') != b.project or envelope.get('task') != b.task
            or envelope.get('kind') != 'direct' or envelope.get('request', {}).get('request_key') != key):
        raise ValueError('recovery context')
    digest = m.payload_digest(envelope['request'])
    decision, decision_sha = b.request(directory / '.decisions' / b.task / (key + '.json'), with_sha=True, private=True)
    if (any(decision.get(k) != v for k, v in {'schema':1, 'project':b.project, 'task':b.task,
            'id':key, 'decision':'approve', 'digest':digest, 'requestSHA':request_sha}.items())
            or decision.get('state') not in ('unknown', 'rejected') or 'grant' in decision or 'result' in decision):
        raise ValueError('recovery decision')
    marker, marker_sha = b.issued_marker(key)
    if marker != {k:decision[k] for k in ('schema','project','task','id','digest','requestSHA','at')}:
        raise ValueError('recovery issue marker')
    session = b.request(b.root / 'inputs/direct-chat-session.json', private=True)
    follow_up = set(session) == {'project','task','discussion_id','exchange_id'}
    if (set(session) not in ({'project','task','discussion_id'}, {'project','task','discussion_id','exchange_id'})
            or session['project'] != b.project or session['task'] != b.task):
        raise ValueError('recovery session')
    with b.ctx.store.connection() as conn:
        discussion = b.ctx.store.get(m.Discussion, session['discussion_id'], conn=conn)
        proof = discussion.open_delivery_proof
        if (discussion.project_id != b.project_id or not discussion.open_request_key
                or not discussion.remote_session
                or discussion.state != 'open' or discussion.open_attempt_state != 'sent'
                or discussion.open_verdict != 'acked' or discussion.open_bytes_handed_off is not True
                or discussion.quarantine_step_id is not None or not discussion.open_payload
                or not proof or proof.kind != 'ack' or proof.step_id != discussion.open_step_id
                or proof.outbound_digest != hashlib.sha256(m.canonical_json(discussion.open_payload.body)).hexdigest()):
            raise ValueError('recovery open not acknowledged')
        if not b.fixture and (discussion.backend != 'live' or not b.binding or
                (discussion.provider,discussion.account,discussion.auth_ref) !=
                (b.binding.provider,b.binding.account,b.binding.auth_ref)):
            raise ValueError('recovery binding changed')
        step = b.ctx.store.get(m.JobStep, discussion.open_step_id, conn=conn)
        job = b.ctx.store.get(m.Job, step.job_id, conn=conn)
        permit = b.ctx.store.get(m.Permit, discussion.open_permit_id, conn=conn)
        if (step.state != 'succeeded' or step.target != discussion.open_payload.target
                or job.operation != 'muse.open' or job.state != 'succeeded' or job.project_id != b.project_id
                or job.request_key != discussion.open_request_key or job.payload.get('topic') != discussion.topic
                or job.payload.get('access_grant_id') != permit.id or permit.kind != 'access'
                or permit.used != 1 or permit.max_uses != 1 or permit.project_id != b.project_id
                or permit.scope.get('operations') != ['muse.open']):
            raise ValueError('recovery open receipt')
        if follow_up:
            inspect_followup(b, conn, envelope, decision, discussion, session['exchange_id'])
        else:
            if discussion.open_request_key != key + '-open' or discussion.topic != envelope['request']['question']:
                raise ValueError('recovery first open changed')
            # First-open proof remains deliberately stricter than follow-up proof.
            for sql, args in [
                    ("SELECT 1 FROM jobs WHERE project_id=? AND (operation='muse.send' OR state IN ('queued','running')) LIMIT 1", (b.project_id,)),
                    ('SELECT 1 FROM exchanges WHERE project_id=? LIMIT 1', (b.project_id,)),
                    ("SELECT 1 FROM permits WHERE project_id=? AND kind='share' LIMIT 1", (b.project_id,)),
                    ("SELECT 1 FROM request_receipts WHERE operation='muse.send' OR request_key=? LIMIT 1", (key + '-send',))]:
                if conn.execute(sql, args).fetchone():
                    raise ValueError('recovery possible send')
    return {'status':'not-sent', 'scope':'follow-up-none' if follow_up else 'question-only', 'open_confirmed':True,
            'id':key, 'project':b.project, 'task':b.task, 'discussion_id':discussion.id,
            'requestSHA':request_sha, 'decisionSHA':decision_sha, 'markerSHA':marker_sha,
            'digest':digest}


def inspect_followup(b, conn, envelope, decision, discussion, previous_id):
    """Prove this exact follow-up never entered the sender; no remote operations."""
    from metamuse import models as m, safety
    from metamuse._muse_lifecycle import _identity, _target, _prepared, _history_baseline
    key = envelope['id']
    if (decision.get('state') != 'unknown'
            or decision.get('diagnostic') != {'code':'send_uncertain', 'phase':'send', 'open_confirmed':True}
            or discussion.open_request_key == key + '-open'):
        raise ValueError('recovery follow-up diagnosis')
    previous = b.ctx.store.get(m.Exchange, previous_id, conn=conn)
    latest = conn.execute('SELECT id FROM exchanges WHERE discussion_id=? ORDER BY rowid DESC LIMIT 1', (discussion.id,)).fetchone()
    if (previous.project_id != b.project_id or previous.discussion_id != discussion.id
            or previous.state != 'closed' or previous.outcome != 'needs_more_data'
            or previous.request_key == key + '-send' or not latest or latest['id'] != previous.id
            or previous.bytes_handed_off is not True or previous.attempt_verdict != 'acked'
            or not previous.delivery_proof or previous.delivery_proof.kind not in ('ack','user_echo','session_marker')
            or not conn.execute("SELECT 1 FROM messages WHERE exchange_id=? AND role='assistant' AND text<>'' LIMIT 1", (previous.id,)).fetchone()):
        raise ValueError('recovery previous exchange changed')
    for sql, args in [
            ("SELECT 1 FROM jobs WHERE request_key=? OR (project_id=? AND state IN ('queued','running')) LIMIT 1", (key + '-send', b.project_id)),
            ('SELECT 1 FROM exchanges WHERE request_key=? LIMIT 1', (key + '-send',)),
            ('SELECT 1 FROM request_receipts WHERE request_key=? LIMIT 1', (key + '-send',)),
            ('SELECT 1 FROM request_receipts WHERE request_key=? LIMIT 1', (key + '-open',))]:
        if conn.execute(sql, args).fetchone():
            raise ValueError('recovery possible follow-up send')
    def receipt(operation, request_key):
        row = conn.execute('SELECT response FROM request_receipts WHERE operation=? AND request_key=?', (operation, request_key)).fetchone()
        if not row:
            raise ValueError('recovery missing receipt')
        return json.loads(row['response'])
    packet = b.ctx.store.get(m.Packet, receipt('packet.prepare', key + '-packet')['id'], conn=conn)
    issued = receipt('permit.create', key + '-send-grant')
    permit = b.ctx.store.get(m.Permit, issued['id'], conn=conn)
    if (permit.model_dump(mode='json') != issued or permit.kind != 'share'
            or permit.project_id != b.project_id or permit.used != 0 or permit.revoked
            or permit.max_uses != 1 or permit.issuer != 'local_operator'
            or permit.scope != {'packet_digests':[packet.digest]}
            or datetime.fromisoformat(permit.issued_at) < datetime.fromisoformat(decision['at'].replace('Z','+00:00'))
            or datetime.fromisoformat(permit.expires_at) != datetime.fromisoformat(envelope['request']['expires_at'].replace('Z','+00:00'))):
        raise ValueError('recovery share permit changed')
    if (packet.project_id != b.project_id or packet.stale
            or packet.digest != hashlib.sha256(packet.rendered_text.encode()).hexdigest()):
        raise ValueError('recovery packet changed')
    _history_baseline(b.ctx.store, discussion)
    # Use only the pinned upstream *pure wire builders*. prepare_send also
    # resolves live cookies, which local recovery must never do.
    identity = _identity('exc', discussion.id, key + '-send')
    binding = m.MuseBinding(provider=discussion.provider, account=discussion.account, auth_ref=discussion.auth_ref)
    target = _target(b.project_id, binding, discussion.backend, 'muse.send',
        intent=identity, session=discussion.remote_session, packet=packet.id)
    question = envelope['request']['question']
    prepared = _prepared('chat.stream', target,
        {'session_id':discussion.remote_session, 'text':question + '\n\n' + packet.rendered_text,
         'node_id':b.project_id}, 'send-' + identity[4:], b.project_id)
    payload = {**prepared.payload, 'question':question, 'packet_text':packet.rendered_text}
    if (permit.exact_digest != safety.action_digest(target, payload)
            or (permit.provider, permit.account) != (discussion.provider, discussion.account)):
        raise ValueError('recovery follow-up scope changed')

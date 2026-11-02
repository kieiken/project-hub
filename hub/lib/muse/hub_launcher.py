#!/usr/bin/python3 -I
"""Fixed Mac sandbox entry. No root, gateway, credential or fixture overrides."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import resource
import subprocess
import sys

HERE = Path(__file__).resolve().parent


def name(value):
    if (not value or value in ('.', '..') or len(value) > 160
            or any(ord(c) < 32 or c in '/\\' for c in value)):
        raise ValueError('context')
    return value


def main():
    parser = argparse.ArgumentParser(description='作業ごとのMetaMuse。入力は秘密を含まないJSONファイル。')
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--project', type=name)
    parser.add_argument('--task', type=name)
    parser.add_argument('--run', action='store_true', help='この呼出しの処理だけ実行。常駐しません。')
    parser.add_argument('--checked-digest')
    parser.add_argument('operation')
    parser.add_argument('request', nargs='?')
    args = parser.parse_args()
    usage = args.operation in ('usage-read', 'usage-status')
    if usage and (args.request or args.run or args.checked_digest or args.project or args.task):
        raise ValueError('usage control arguments')
    if not usage and (args.project is None or args.task is None):
        parser.error('--project and --task are required for task operations')
    approval = args.operation in ('approval-preview', 'approval-issue')
    if args.operation == 'direct-inspect' and (not args.request or args.run or args.checked_digest):
        raise ValueError('recovery inspection arguments')
    if args.checked_digest and (args.operation != 'approval-issue' or not re.fullmatch('[a-f0-9]{64}', args.checked_digest)):
        raise ValueError('checked digest')
    if approval and (not args.request or args.run or args.operation == 'approval-issue' and not args.checked_digest):
        raise ValueError('approval arguments')
    if sys.platform != 'darwin':
        raise ValueError('macOS sandbox required')
    spec = importlib.util.spec_from_file_location('settings_terminal', HERE / 'terminal.py')
    terminal = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(terminal)
    bundle = Path(args.bundle)
    terminal.verify_bundle(bundle)
    private = Path(pwd.getpwuid(os.getuid()).pw_dir) / 'Library/Application Support/metamuse-hub-20260926-hub-v2'
    if usage:
        # Account metadata has no project/task. Reuse the existing sandbox's
        # exact taskroot boundary for this one fixed account-level directory.
        project = taskroot = private / 'usage'
    else:
        # This approved fixed installation lives in a task copy below AI-Workspace/Work.
        workspace_root = bundle.parents[5]
        project = workspace_root / 'Product' / args.project
        task = project / '.ai' / 'tasks' / (args.task + '.md')
        current = Path('/')
        for part in task.parts[1:]:
            current /= part
            if current.is_symlink():
                raise ValueError('linked project')
        if not task.is_file() or not project.is_dir():
            raise ValueError('existing Hub task required')
        taskroot = private / 'projects' / args.project / args.task
    if args.operation == 'menu' and not all(s.isatty() for s in (sys.stdin, sys.stdout, sys.stderr)):
        raise ValueError('human terminal required')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.umask(0o077)
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8', 'TZ': 'UTC',
           'PYTHONDONTWRITEBYTECODE': '1', 'OTEL_SDK_DISABLED': 'true', 'DO_NOT_TRACK': '1', 'NO_COLOR': '1'}
    extra_spec = importlib.util.spec_from_file_location('hub_extras', HERE / 'extras.py')
    extras = importlib.util.module_from_spec(extra_spec)
    extra_spec.loader.exec_module(extras)
    # The owner control plane must remain reachable after a failed install.
    # It runs only trusted base dependencies, never an unrecorded partial venv.
    executable = bundle / '.venv/bin/python' if usage or args.operation == 'menu' else extras.interpreter(bundle, taskroot)
    fb_spec = importlib.util.spec_from_file_location('hub_facebook_runtime', HERE / 'facebook_runtime.py')
    facebook_runtime = importlib.util.module_from_spec(fb_spec)
    fb_spec.loader.exec_module(facebook_runtime)
    if args.operation == 'mcp':
        if args.request or args.run:
            raise ValueError('MCP has fixed arguments')
        os.execve(str(bundle / '.venv/bin/python'), [str(bundle / '.venv/bin/python'), '-I', '-B',
            str(HERE / 'hub_mcp.py'), '--bundle', str(bundle), '--project', args.project, '--task', args.task], env)
    common = [str(executable), '-I', '-B', str(HERE / 'hub_core.py'), '--legacy', str(private)]
    if not usage:
        common += ['--taskroot', str(taskroot), '--project-dir', str(project), '--inputs', str(bundle / 'inputs'),
                   '--project', args.project, '--task', args.task]
    if args.run:
        common.append('--run')

    facebook = False

    def command(mode, digest=None):
        profile = 'hub-approval.sb' if approval or args.operation in ('direct-inspect', 'usage-status') or args.operation in ('direct-chat', 'direct-read', 'direct-poll') and mode == 'check' else facebook_runtime.profile_name(mode, args.operation, facebook, taskroot, bundle)
        return ['/usr/bin/sandbox-exec', '-D', 'bundle=' + str(bundle), '-D', 'bridge=' + str(HERE),
                '-D', 'private=' + str(private), '-D', 'taskroot=' + str(taskroot),
                '-D', 'project=' + str(project), '-D', 'taskparent=' + str(taskroot.parent), '-f', str(HERE / profile),
                *common, '--mode', mode, *(['--checked-digest', digest] if digest else []), args.operation, *([args.request] if args.request else [])]

    # A separate network-denied process verifies an existing human-issued grant.
    # No process can relax its own sandbox and no user-supplied --live flag exists.
    remote = args.operation in ('direct-chat', 'direct-read', 'direct-poll', 'metamuse_muse_open', 'metamuse_muse_send', 'metamuse_muse_read', 'metamuse_collect', 'metamuse_publication_submit', 'metamuse_publication_reconcile')
    online = args.operation == 'usage-read'
    digest = None
    if remote:
        check = subprocess.run(command('check'), env=env, capture_output=True, timeout=30)
        if check.returncode:
            raise ValueError('preflight refused')
        result = json.loads(check.stdout)
        online, digest = result.get('live') is True, result.get('digest')
        facebook = result.get('facebook_collection') is True
        if not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest):
            raise ValueError('preflight digest')
    if online and facebook:
        cache = facebook_runtime.require_supported_runtime(taskroot, bundle)
        executable = extras.browser_interpreter(bundle, taskroot)
        common[0] = str(executable)
        env['PLAYWRIGHT_BROWSERS_PATH'] = str(cache)
    os.chdir(bundle)
    if args.operation == 'menu':
        result = subprocess.run(command('offline'), env=env)
        if result.returncode != 15:
            raise SystemExit(result.returncode)
        if not all(stream.isatty() for stream in (sys.stdin, sys.stdout, sys.stderr)):
            raise ValueError('human terminal required')
        download_command = command('offline')
        download_command[download_command.index('-f') + 1] = str(HERE / 'hub-download.sb')
        download_command = download_command[:download_command.index(str(executable))] + [str(bundle / '.venv/bin/python'), '-I', '-B', str(HERE / 'browser_download.py'), str(taskroot)]
        os.execve('/usr/bin/sandbox-exec', download_command, env)
    os.execve('/usr/bin/sandbox-exec', command('live' if online else 'offline', digest if online else args.checked_digest if approval else None), env)


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt):
        print('MetaMuseを安全に起動できませんでした。自動再送せず、作業と入力を確認してください。', file=sys.stderr)
        sys.exit(2)

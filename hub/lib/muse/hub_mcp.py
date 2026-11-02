"""Task-bound stdio MCP. Dispatch only; each operation gets its own OS sandbox.

This server has no approval/auth/cancel tools and does not attach an upstream worker.
Only the job returned by a call is advanced. Cancellation never implies a resend.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import uuid

import anyio
from mcp import types
from mcp.server import Server
from mcp.server.stdio import stdio_server
from metamuse import mcp as upstream_mcp
from metamuse import models as m

# Explicit import: no user-supplied module path, server, workspace or tool registry.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hub_core import private_dir, save, credential_text


class Dispatcher:
    def __init__(self, launcher, bundle, project, task, taskroot):
        self.launcher, self.bundle = Path(launcher), Path(bundle)
        self.project, self.task, self.root = project, task, Path(taskroot)
        self.lock = threading.Lock()

    def call(self, tool, arguments):
        if tool not in m.TOOL_REQUEST_MODELS or not isinstance(arguments, dict):
            return {'status': 'stopped', 'notice': 'Unknown tool or invalid arguments'}
        raw = json.dumps(arguments, ensure_ascii=False, allow_nan=False)
        if len(raw.encode()) > 2 * 1024 * 1024 or credential_text(raw.encode()):
            return {'status': 'stopped', 'notice': 'Credential-like or oversized input refused'}
        if not self.lock.acquire(blocking=False):
            return {'status': 'stopped', 'notice': 'Another operation is active; inspect its state before continuing'}
        try:
            private_dir(self.root / 'inputs')
            path = self.root / 'inputs' / ('mcp-' + uuid.uuid4().hex + '.json')
            save(path, raw)
            # The outer launcher derives/validates the same workspace and controls live preflight.
            command = ['/usr/bin/python3', '-I', str(self.launcher), '--bundle', str(self.bundle),
                       '--project', self.project, '--task', self.task, '--run', tool, str(path)]
            try:
                result = subprocess.run(command, capture_output=True, timeout=960, env={
                    'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8', 'TZ': 'UTC',
                    'OTEL_SDK_DISABLED': 'true', 'DO_NOT_TRACK': '1', 'PYTHONDONTWRITEBYTECODE': '1'})
                if len(result.stdout) > 8 * 1024 * 1024:
                    raise ValueError('output limit')
                value = json.loads(result.stdout)
                if not isinstance(value, dict):
                    raise ValueError('output')
                return value
            except (Exception, KeyboardInterrupt):
                return {'status': 'stopped', 'notice': 'Result unknown. Read saved jobs/history; do not resend. Publication uses reconcile only.'}
        finally:
            self.lock.release()


def create_server(dispatcher):
    tools = upstream_mcp.list_tools()
    async def list_tools(_context, _params):
        return types.ListToolsResult(tools=tools)
    async def call_tool(_context, params):
        # Shield the accepted call from client cancellation; no duplicate worker/retry.
        value = await anyio.to_thread.run_sync(lambda: dispatcher.call(params.name, params.arguments or {}))
        text = json.dumps(value, ensure_ascii=False)
        return types.CallToolResult(content=[types.TextContent(type='text', text=text)],
                                    is_error=value.get('status') in ('error', 'stopped'))
    server = Server('metamuse-hub', version='0.1.0a2',
                    on_list_tools=list_tools, on_call_tool=call_tool)
    # No telemetry middleware, global registration or upstream attached worker.
    server.middleware = []
    return server


async def serve(dispatcher):
    server = create_server(dispatcher)
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--task', required=True)
    args = parser.parse_args()
    # Invoked only after the fixed launcher's bundle/existing-task checks.
    import pwd
    private = Path(pwd.getpwuid(os.getuid()).pw_dir) / 'Library/Application Support/metamuse-hub-20260926-hub-v2'
    from hub_launcher import name
    root = private / 'projects' / name(args.project) / name(args.task)
    asyncio.run(serve(Dispatcher(Path(__file__).with_name('hub_launcher.py'), args.bundle, args.project, args.task, root)))


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt):
        print('MetaMuse MCP stopped; inspect saved state before any retry.', file=sys.stderr)
        sys.exit(2)

"""FB classification and missing-runtime refusal. Expanded OS probes: muse-hub-r02b.py."""
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1] / 'lib/muse'
BUNDLE = HERE.parents[2] / '.ai/work/metamuse-local-20261024'
spec = importlib.util.spec_from_file_location('fb_runtime', HERE / 'facebook_runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class Runtime(unittest.TestCase):
    def test_only_facebook_post_comment_collection_classified(self):
        request = {'inputs': [{'kind': 'url', 'url': 'https://www.facebook.com/synth/posts/123456'}],
                   'resources': ['post', 'comments'], 'request_key': 'synthetic',
                   'access_grant_id': None, 'project_id': 'proj_synthetic',
                   'limits': {'max_urls': 1, 'max_items': 2, 'max_bytes': 10000, 'wall_clock_seconds': 30}}
        self.assertTrue(runtime.is_facebook_collection('metamuse_collect', request))
        for other in ({**request, 'resources': ['media_metadata']},
                      {**request, 'inputs': [{'kind': 'url', 'url': 'https://example.com/video'}]},
                      {**request, 'inputs': [{'kind': 'text', 'text': 'local text'}]}):
            self.assertFalse(runtime.is_facebook_collection('metamuse_collect', other))
        self.assertFalse(runtime.is_facebook_collection('metamuse_publication_submit', {}))

    def test_fb_live_requires_verified_adapter(self):
        with self.assertRaisesRegex(ValueError, 'task runtime verification failed'):
            runtime.profile_name('live', 'metamuse_collect', True)
        self.assertEqual(runtime.profile_name('check', 'metamuse_collect', True), 'hub-offline.sb')
        self.assertEqual(runtime.profile_name('live', 'metamuse_muse_send'), 'hub-live.sb')
        self.assertEqual(runtime.profile_name('live', 'metamuse_collect', False), 'hub-live.sb')
        self.assertEqual(runtime.profile_name('offline', 'menu'), 'hub-human.sb')
        self.assertNotIn('hub-fb-live.sb', (HERE / 'hub_launcher.py').read_text())

    def test_bridge_refuses_fb_before_external_tool_or_grant_consumption(self):
        helper_spec = importlib.util.spec_from_file_location('r02_journey', HERE.parents[1] / 'test/muse-hub-bridge.py')
        helper = importlib.util.module_from_spec(helper_spec)
        helper_spec.loader.exec_module(helper)
        journey = helper.Journey()
        journey.setUp()
        try:
            request = {'inputs': [{'kind': 'url', 'url': 'https://www.facebook.com/synth/posts/123456'}],
                'resources': ['post'], 'request_key': 'synthetic', 'access_grant_id': 'synthetic-only',
                'limits': {'max_urls': 1, 'max_items': 2, 'max_bytes': 10000, 'wall_clock_seconds': 30}}
            with journey.b.open(), patch.object(journey.b, 'live_grant', return_value=True), \
                    patch.dict(helper.app.TOOL_FUNCTIONS, {'metamuse_collect': unittest.mock.Mock()}) as tools:
                journey.b.fixture = False
                with self.assertRaisesRegex(ValueError, 'browser collection on this Mac is blocked'):
                    journey.b.call('metamuse_collect', request, run=True, online=True)
                tools['metamuse_collect'].assert_not_called()
        finally:
            journey.doCleanups()

    # Ephemeral loopback and explicit service-denial OS coverage now lives in
    # muse-hub-r02b.py Profiles; the old one-selected-port boundary is superseded.


if __name__ == '__main__':
    unittest.main(verbosity=2)

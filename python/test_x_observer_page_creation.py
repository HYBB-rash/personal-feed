import json
import unittest
from unittest import mock

import x_personal_feed_observer as observer
import x_personal_feed_observer_cli as cli
from test_x_personal_feed_observer import _FakeClock, _FakeBrowser, _FakeLock, _FakeEvaluator, _invoke
from test_x_personal_feed_observer_cli import _FakeHTTPResponse


class PageCreationTests(unittest.TestCase):
    def test_no_entry_page_creates_once_and_observes_all_surfaces(self):
        for tabs in ([], [{'type': 'page', 'url': 'https://x.com/alice/status/123'}]):
            with self.subTest(tabs=tabs):
                clock = _FakeClock(1_000_000)
                browser = _FakeBrowser(clock, tabs=tabs)
                browser.is_x_tab = lambda tab: cli._ExistingCdpBrowser.is_x_tab(browser, tab)
                browser.create_x_tab = mock.Mock(return_value={
                    'type': 'page', 'url': 'https://x.com/home',
                    'webSocketDebuggerUrl': 'ws://127.0.0.1:9222/devtools/page/new',
                })
                evaluator = _FakeEvaluator(clock)
                result = _invoke(observer, clock, browser, _FakeLock(), evaluator)
                self.assertEqual(result['kind'], 'complete')
                browser.create_x_tab.assert_called_once_with(100.0)
                self.assertEqual({c['surface'] for c in evaluator.calls}, set(observer.SURFACES))
                self.assertTrue(all(c['ws_url'].endswith('/new') for c in evaluator.calls))

    def test_existing_entry_is_reused_without_creating_another_page(self):
        clock = _FakeClock(1_000_000)
        browser = _FakeBrowser(clock)
        browser.create_x_tab = mock.Mock(side_effect=AssertionError('must reuse'))
        result = _invoke(observer, clock, browser, _FakeLock(), _FakeEvaluator(clock))
        self.assertEqual(result['kind'], 'complete')
        browser.create_x_tab.assert_not_called()

    def test_creation_failure_or_expired_budget_stops_without_retry_or_navigation(self):
        for value in (None, {}, {'type': 'page', 'url': 'https://example.org'}, 'expired'):
            with self.subTest(value=value):
                clock = _FakeClock(1_000_000)
                browser = _FakeBrowser(clock, tabs=[])
                def create(timeout):
                    if value == 'expired':
                        clock.now = 1_100_001
                        return {'type': 'page', 'url': 'https://x.com/home', 'webSocketDebuggerUrl': 'ws://x/new'}
                    return value
                browser.create_x_tab = mock.Mock(side_effect=create)
                evaluator = _FakeEvaluator(clock)
                result = _invoke(observer, clock, browser, _FakeLock(), evaluator)
                self.assertEqual(result['kind'], 'incomplete')
                browser.create_x_tab.assert_called_once()
                self.assertEqual(evaluator.calls, [])

    def test_creation_uses_fixed_loopback_put_with_bounded_response(self):
        browser = cli._ExistingCdpBrowser(clock=mock.Mock(), deadline_epoch_ms=10_000)
        tab = {'type': 'page', 'url': 'https://x.com/home', 'webSocketDebuggerUrl': 'ws://127.0.0.1:9222/devtools/page/new'}
        sizes = []
        with mock.patch.object(cli.urllib.request, 'urlopen', return_value=_FakeHTTPResponse(json.dumps(tab).encode(), sizes)) as request:
            self.assertEqual(browser.create_x_tab(2.5), tab)
        req = request.call_args.args[0]
        self.assertEqual(req.full_url, 'http://127.0.0.1:9222/json/new?https://x.com/home')
        self.assertEqual(req.get_method(), 'PUT')
        self.assertEqual(request.call_args.kwargs['timeout'], 2.5)
        self.assertEqual(sizes, [cli.MAX_HTTP_BYTES + 1])

    def test_creation_rejects_invalid_and_remote_targets(self):
        browser = cli._ExistingCdpBrowser(clock=mock.Mock(), deadline_epoch_ms=10_000)
        for value in ([], {}, {'type': 'page', 'url': 'https://x.com/home', 'webSocketDebuggerUrl': 'ws://remote.example/devtools/page/1'}):
            with self.subTest(value=value), mock.patch.object(cli.urllib.request, 'urlopen', return_value=_FakeHTTPResponse(json.dumps(value).encode(), [])):
                self.assertIsNone(browser.create_x_tab(1))
        with mock.patch.object(cli.urllib.request, 'urlopen', side_effect=TimeoutError):
            self.assertIsNone(browser.create_x_tab(1))


if __name__ == '__main__':
    unittest.main()

import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('monitor', Path(__file__).with_name('monitor-production.py'))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class MonitorTests(unittest.TestCase):
    def test_healthy_state(self):
        now = 2000000000
        job = {'lastSuccessAt': '2033-05-18T03:33:20Z', 'consecutiveFailures': 0}
        self.assertEqual([], monitor.assess(now, {'lastSuccessAt': now - 60}, job, job,
                                            40, 20, True, {'nginx': True, 'postgresql': True}, True))

    def test_stale_backup_and_jobs_alert(self):
        alerts = monitor.assess(2000000000, None, None, None, 91, 80, False,
                                {'nginx': True, 'postgresql': False}, False)
        self.assertIn('verified_backup_stale', alerts)
        self.assertIn('payment_expiry_stale', alerts)
        self.assertIn('cdek_sync_stale', alerts)
        self.assertIn('disk_critical', alerts)
        self.assertIn('db_readiness_failed', alerts)

    def test_http_5xx_spike(self):
        now = 2000000000
        good = {'lastSuccessAt': now, 'consecutiveFailures': 0}
        alerts = monitor.assess(now, {'lastSuccessAt': now}, good, good, 40, 20,
                                True, {'nginx': True, 'postgresql': True}, True, (10, 5))
        self.assertIn('http_5xx_spike', alerts)

    def test_nginx_log_counts_recent_status_without_exposing_request(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'access.log'
            log.write_text('127.0.0.1 - - [18/May/2033:03:33:20 +0000] "GET /private?a=1 HTTP/1.1" 500 10\n'
                           '127.0.0.1 - - [18/May/2033:03:33:20 +0000] "GET / HTTP/1.1" 200 10\n')
            self.assertEqual((2, 1), monitor.recent_http_errors(log, 2000000000))


if __name__ == '__main__':
    unittest.main()

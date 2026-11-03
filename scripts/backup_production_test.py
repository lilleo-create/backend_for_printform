import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

MODULE = Path(__file__).with_name('backup-production.py')
spec = importlib.util.spec_from_file_location('printform_backup', MODULE)
backup = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(backup)


class BackupSafetyTests(unittest.TestCase):
    def test_config_parser_does_not_execute_shell_text(self):
        with TemporaryDirectory() as temp:
            path = Path(temp) / 'config'
            path.write_text('RESTIC_REPOSITORY="s3:https://example.invalid/bucket"\nAWS_SECRET_ACCESS_KEY=$(echo unsafe)\n')
            values = backup.read_env(path)
            self.assertEqual(values['AWS_SECRET_ACCESS_KEY'], '$(echo unsafe)')
            self.assertEqual(values['RESTIC_REPOSITORY'], 's3:https://example.invalid/bucket')

    def test_database_password_is_passed_only_in_child_environment(self):
        env = backup.db_environment('postgresql://test:secret%21@127.0.0.1:5432/printform')
        self.assertEqual(env['PGPASSWORD'], 'secret!')
        self.assertEqual(env['PGDATABASE'], 'printform')

    def test_private_uploads_cannot_be_inside_public_tree(self):
        with self.assertRaises(ValueError):
            backup.backup_scope({'PRIVATE_UPLOADS_DIR': str(backup.APP_ROOT / 'uploads' / 'chats')})


if __name__ == '__main__':
    unittest.main()

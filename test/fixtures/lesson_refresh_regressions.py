"""Exercise the real lesson refresh without providers or production state."""
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


class LessonRefreshRegression(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data = self.root / '.omx/atelier/lessons'
        self.data.mkdir(parents=True)
        cards = self.root / '.omx/atelier/scorecards'
        cards.mkdir()
        for index in range(10):
            path = cards / f'{10-index}.json'
            path.write_text(json.dumps({'defects': [{'id': index}]}))
            os.utime(path, (index, index))
        (self.data / 'trend.jsonl').write_text('\n'.join(json.dumps({'turn': i}) for i in range(20)))
        cfg = self.root / '.sinter/config.json'
        cfg.parent.mkdir()
        cfg.write_text(json.dumps({'roles': {'harness': {'apiKey': 'fixture-only'}}}))
        for name, identity in [('hints-active', 'active'), ('hints', 'working'), ('hints-staging', 'staged')]:
            (self.data / f'{name}.json').write_text(json.dumps([{'id': identity, 'text': 'retain', 'domains': ['p5']}]))

    def tearDown(self):
        self.tmp.cleanup()

    def refresh(self, response):
        captured = []
        def reply(request, timeout):
            captured.append(json.loads(request.data)['messages'][0]['content'])
            return io.BytesIO(json.dumps({'content': [{'type': 'text', 'text': json.dumps(response)}]}).encode())
        previous = Path.cwd()
        try:
            os.chdir(self.root)
            with patch.dict(os.environ, {'HOME': str(self.root)}), patch.object(sys, 'path', [str(ROOT / 'scripts/atelier')] + sys.path), patch('urllib.request.urlopen', reply):
                runpy.run_path(str(ROOT / 'scripts/atelier/refresh-lessons.py'), run_name='__main__')
        finally:
            os.chdir(previous)
        return captured[0]

    def test_partial_response_preserves_rules_and_refines_matching_id(self):
        prompt = self.refresh([{'id': 'staged', 'text': 'refined', 'domains': ['p5']}, {'id': 'new', 'text': 'new'}])
        rules = {r['id']: r for r in json.loads((self.data / 'hints-staging.json').read_text())}
        self.assertEqual(set(rules), {'active', 'working', 'staged', 'new'})
        self.assertEqual(rules['staged']['text'], 'refined')
        self.assertTrue(all(f'"id": "{name}"' in prompt for name in ('active', 'working', 'staged')))
        self.assertIn('"turn": 14', prompt)
        self.assertNotIn('"turn": 13', prompt)
        self.assertIn('"id": 2', prompt)
        self.assertNotIn('"id": 0', prompt)

    def test_invalid_or_empty_response_keeps_staging_bytes(self):
        path = self.data / 'hints-staging.json'
        previous = path.read_bytes()
        for response in ([], [None], [{'id': 'broken'}], [{'id': 'bad', 'text': 42}]):
            with self.subTest(response=response):
                self.refresh(response)
                self.assertEqual(path.read_bytes(), previous)

    def test_corrupt_existing_rules_refuse_provider_and_preserve_staging(self):
        path = self.data / 'hints-staging.json'
        previous = path.read_bytes()
        (self.data / 'hints.json').write_text('[null]')
        with self.assertRaisesRegex(ValueError, 'invalid existing lessons'):
            self.refresh([{'id': 'new', 'text': 'new'}])
        self.assertEqual(path.read_bytes(), previous)


if __name__ == '__main__':
    unittest.main()

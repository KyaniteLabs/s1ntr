"""Exercise actual graduation from split, pinned generation/score events."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/atelier"))
from learning_turns import genome_digest, scored_turns, paired_plan, paired_scope, paired_turns
from genome_guard import remove_if_genomes_match


class GraduationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.lessons = self.root / ".omx/atelier/lessons"
        self.lessons.mkdir(parents=True)
        self.active = self.lessons / "hints-active.json"
        self.staged = self.lessons / "hints-staging.json"
        self.active.write_text(json.dumps([{"id": "old", "text": "Old rule"}]))
        self.staged.write_text(json.dumps([{"id": "new", "text": "New rule"}]))
        self.pins = {"active": genome_digest(self.active), "staged": genome_digest(self.staged)}
        self.trend = self.lessons / "trend.jsonl"

    def rows(self):
        rows = []
        for i in range(8):
            arm = "active" if i % 2 == 0 else "staged"
            path = str(self.root / f"art-{i}")
            rows.append({"event_type": "generation_context", "artifact": path,
                "arm": arm, "domain": "p5", "model": "test-model", "turn": i + 1,
                "candidate_genome_sha256": self.pins[arm]})
            score = 4 if arm == "active" else 7
            rows.append({"event_type": "artifact_scored", "artifact": path + "/playable.html",
                "domain": "p5", "model": "test-model", "scoreScale": 10,
                "axes": f"D={score} A={score} R=5 N=5", "judges": ["judge-a", "judge-b"]})
        return rows

    def write_rows(self, rows):
        self.trend.write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    def one_pair(self, rows):
        artifacts = {r['artifact'] for r in rows if r.get('event_type') == 'generation_context'
                     and r.get('pair_id') == 'p5-pair-0'}
        return [r for r in rows if r.get('artifact') in artifacts or
                str(Path(r.get('artifact', '')).parent) in artifacts]

    def run_gate(self, *args):
        return subprocess.run([sys.executable, str(ROOT / "scripts/atelier/graduate.py"), *args],
                              cwd=self.root, capture_output=True, text=True)

    def test_split_events_count_scored_turns_and_promote_atomically(self):
        self.write_rows(self.rows())
        self.assertEqual(len(scored_turns(self.trend, self.pins)), 8)
        expected = self.staged.read_bytes()
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("GRADUATED", result.stdout)
        self.assertEqual(self.active.read_bytes(), expected)

    def test_stale_candidate_cannot_receive_historical_credit(self):
        self.write_rows(self.rows())
        self.staged.write_text(json.dumps([{"id": "other", "text": "Untested rule"}]))
        before = self.active.read_bytes()
        result = self.run_gate()
        self.assertIn("kept pending", result.stdout)
        self.assertEqual(self.active.read_bytes(), before)
        self.assertTrue(self.staged.exists())

    def test_unqualified_or_mismatched_score_never_joins(self):
        rows = self.rows()
        rows[1]["domain"] = "glsl"
        rows[3]["judges"] = ["judge-a", "judge-a"]
        rows[5]["axes"] = "D=NaN A=7 R=5 N=5"
        self.write_rows(rows)
        self.assertEqual(len(scored_turns(self.trend, self.pins)), 5)

    def test_rejudging_does_not_inflate_sample_size(self):
        rows = self.rows()
        self.write_rows(rows + [rows[-1]] * 10)
        self.assertEqual(len(scored_turns(self.trend, self.pins)), 8)

    def test_model_change_is_not_a_lesson_win(self):
        rows = self.rows()
        rows[0]["model"] = rows[1]["model"] = "different-model"
        self.write_rows(rows)
        result = self.run_gate()
        self.assertIn("kept pending", result.stdout)
        self.assertTrue(self.staged.exists())

    def enable_pairs(self, domains):
        self.config = self.lessons / 'paired-domains.json'
        self.config.write_text(json.dumps({'domains': domains, 'offset': 0}))
        for path in [self.active, self.staged]:
            rules = json.loads(path.read_text())
            for rule in rules:
                rule['domains'] = domains
            path.write_text(json.dumps(rules))
        self.pins = {'active': genome_digest(self.active), 'staged': genome_digest(self.staged)}
        rows = []
        for domain in domains:
            batch = self.rows()
            for i, row in enumerate(batch):
                row['domain'] = domain
                row['artifact'] = row['artifact'].replace('art-', domain + '-art-')
                if row['event_type'] == 'generation_context':
                    row['pair_id'] = f'{domain}-pair-{i // 4}'
                    row['prompt'] = f'{domain} prompt {i // 4}'
                    row['persona'] = 'fixed-persona'
            rows.extend(batch)
        return rows

    def test_pairs_across_domains_survive_more_than_twelve_turns(self):
        rows = self.enable_pairs(['p5', 'glsl'])
        self.write_rows(rows)
        self.assertEqual(len(paired_turns(scored_turns(self.trend, self.pins), ['p5', 'glsl'])), 16)
        result = self.run_gate()
        self.assertIn('GRADUATED', result.stdout)

    def test_missing_changed_domain_cannot_graduate(self):
        rows = self.enable_pairs(['p5', 'glsl'])
        self.write_rows(rows[:16])
        result = self.run_gate()
        self.assertIn('glsl needs two matched prompt pairs', result.stdout)
        self.assertTrue(self.staged.exists())

    def test_pair_mismatches_and_duplicate_judging_never_add_credit(self):
        rows = self.enable_pairs(['p5'])
        rows[2]['prompt'] = 'different task'
        rows[6]['persona'] = 'different persona'
        rows[11]['judges'] = ['other-a', 'other-b']
        self.write_rows(rows + [rows[-1]] * 5)
        turns = scored_turns(self.trend, self.pins)
        self.assertEqual(len(paired_turns(turns, ['p5'])), 2)
        self.assertIn('kept pending', self.run_gate().stdout)

    def test_missing_persona_keeps_default_none_identity(self):
        rows = self.one_pair(self.enable_pairs(['p5']))
        for row in rows:
            if row.get('event_type') == 'generation_context':
                row.pop('persona')
        self.write_rows(rows)
        self.assertEqual(len(paired_turns(scored_turns(self.trend, self.pins), ['p5'])), 2)

    def test_plan_is_counterbalanced_and_persistent_with_control(self):
        self.enable_pairs(['p5', 'glsl'])
        table = ['p5', 'p5', 'glsl', 'glsl']
        plans = [paired_plan(i, table, self.config, self.active, self.staged) for i in range(1, 19)]
        self.assertEqual([plans[i][1] for i in [8, 17]], ['control', 'control'])
        self.assertEqual([p[1] for p in plans[:4]], ['active', 'staged', 'staged', 'active'])
        for i in [0, 2, 4, 6, 9, 11, 13, 15]:
            a, b = plans[i:i + 2]
            self.assertEqual((a[0], a[2], a[3]), (b[0], b[2], b[3]))
            self.assertEqual({a[1], b[1]}, {'active', 'staged'})
            self.assertEqual(a[4], self.pins[a[1]])
        old = plans[0][3]
        self.staged.write_text(json.dumps([{'id': 'new', 'text': 'changed', 'domains': ['p5', 'glsl']}]))
        self.assertNotEqual(paired_plan(1, table, self.config, self.active, self.staged)[3], old)

    def test_invalid_or_incomplete_scope_fails_closed(self):
        self.enable_pairs(['p5', 'glsl'])
        self.config.write_text(json.dumps({'domains': ['p5']}))
        with self.assertRaises(ValueError):
            paired_scope(self.config, self.active, self.staged)
        self.config.write_text(json.dumps({'domains': ['p5', 'glsl'], 'offset': True}))
        with self.assertRaises(ValueError):
            paired_scope(self.config, self.active, self.staged)

    def test_scope_accepts_subset_and_does_not_schedule_unchanged_domains(self):
        self.enable_pairs(['p5'])
        self.config.write_text(json.dumps({'domains': ['p5', 'three', 'glsl']}))
        self.assertEqual(paired_scope(self.config, self.active, self.staged)[0], ['p5'])
        plans = [paired_plan(i, ['p5', 'three', 'glsl'], self.config, self.active, self.staged)
                 for i in range(1, 19)]
        self.assertEqual({p[0] for p in plans}, {0})

    def test_paired_quality_regression_cannot_be_hidden_by_other_domain_wins(self):
        rows = self.enable_pairs(['p5', 'glsl'])
        for row in rows:
            if row['event_type'] == 'artifact_scored' and row['domain'] == 'p5' and 'D=7' in row['axes']:
                row['axes'] = 'D=7 A=7 R=1 N=5'
        self.write_rows(rows)
        before = self.active.read_bytes()
        result = self.run_gate()
        self.assertIn('CULLED', result.stdout)
        self.assertEqual(self.active.read_bytes(), before)

    def test_pair_regression_cannot_be_hidden_by_same_domain_improvements(self):
        for axis in ('R', 'N'):
            with self.subTest(axis=axis):
                rows = self.enable_pairs(['p5'])
                for i, row in enumerate(rows):
                    if row['event_type'] == 'artifact_scored' and 'D=7' in row['axes']:
                        value = 4 if i == 3 else 8
                        row['axes'] = row['axes'].replace(f'{axis}=5', f'{axis}={value}')
                self.write_rows(rows)
                before = self.active.read_bytes()
                self.assertIn('CULLED', self.run_gate().stdout)
                self.assertEqual(self.active.read_bytes(), before)
                self.staged.write_text(json.dumps([{'id': 'new', 'text': 'New rule'}]))

    def test_one_complete_pinned_pair_culls_rn_regression_before_sample_minimum(self):
        original_active, original_staged = self.active.read_bytes(), self.staged.read_bytes()
        for axis in ('R', 'N'):
            with self.subTest(axis=axis):
                self.active.write_bytes(original_active)
                self.staged.write_bytes(original_staged)
                rows = self.one_pair(self.enable_pairs(['p5']))
                active_bytes = self.active.read_bytes()
                for row in rows:
                    if row.get('event_type') == 'artifact_scored' and row['axes'].startswith('D=7'):
                        row['axes'] = f'D=7 A=7 R={4 if axis == "R" else 5} N={4 if axis == "N" else 5}'
                self.write_rows(rows)
                self.assertEqual(len(paired_turns(scored_turns(self.trend, self.pins), ['p5'])), 2)
                history_bytes = self.trend.read_bytes()
                result = self.run_gate()
                self.assertIn('CULLED: paired p5 regressed', result.stdout)
                self.assertIn('before graduation sample minimum', result.stdout)
                self.assertEqual(self.active.read_bytes(), active_bytes)
                self.assertEqual(self.trend.read_bytes(), history_bytes)
                self.assertFalse(self.staged.exists())

    def test_early_reject_only_culls_pinned_pair_without_graduating(self):
        rows = self.one_pair(self.enable_pairs(['p5']))
        for row in rows:
            if row.get('event_type') == 'artifact_scored' and row['axes'].startswith('D=7'):
                row['axes'] = 'D=7 A=7 R=4 N=4'
        self.write_rows(rows)
        active_bytes, history_bytes = self.active.read_bytes(), self.trend.read_bytes()
        result = self.run_gate('--early-reject-only')
        self.assertIn('CULLED: paired p5 regressed', result.stdout)
        self.assertEqual(self.active.read_bytes(), active_bytes)
        self.assertEqual(self.trend.read_bytes(), history_bytes)
        self.assertFalse(self.staged.exists())

    def test_early_reject_only_never_promotes_nonregressing_candidate(self):
        rows = self.enable_pairs(['p5'])
        self.write_rows(rows)
        active_bytes, staged_bytes = self.active.read_bytes(), self.staged.read_bytes()
        result = self.run_gate('--early-reject-only')
        self.assertIn('early paired check complete', result.stdout)
        self.assertEqual(self.active.read_bytes(), active_bytes)
        self.assertEqual(self.staged.read_bytes(), staged_bytes)

    def test_malformed_pair_identity_cannot_cull_or_change_history(self):
        original_active, original_staged = self.active.read_bytes(), self.staged.read_bytes()
        cases = [('pair_id', '   '), ('prompt', '  '), ('persona', ''),
                 ('persona', '   '), ('model', '  ')]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                self.active.write_bytes(original_active)
                self.staged.write_bytes(original_staged)
                rows = self.one_pair(self.enable_pairs(['p5']))
                for row in rows:
                    if row.get('event_type') == 'generation_context':
                        row[field] = value
                    elif field == 'model':
                        row['model'] = value
                    if (row.get('event_type') == 'artifact_scored' and
                            row['axes'].startswith('D=7')):
                        row['axes'] = 'D=7 A=7 R=4 N=5'
                self.write_rows(rows)
                self.assertEqual(paired_turns(scored_turns(self.trend, self.pins), ['p5']), [])
                history_bytes = self.trend.read_bytes()
                result = self.run_gate()
                self.assertIn('gate needs N>=4 per arm', result.stdout)
                self.assertEqual(self.trend.read_bytes(), history_bytes)
                self.assertTrue(self.staged.exists())

    def test_incomplete_pair_and_nonregressing_pair_remain_pending(self):
        for incomplete in (True, False):
            with self.subTest(incomplete=incomplete):
                rows = self.one_pair(self.enable_pairs(['p5']))
                if incomplete:
                    staged_artifacts = {r['artifact'] for r in rows
                        if r.get('event_type') == 'generation_context' and r['arm'] == 'staged'}
                    rows = [r for r in rows if not (
                        r.get('event_type') == 'artifact_scored' and
                        str(Path(r['artifact']).parent) in staged_artifacts)]
                else:
                    for row in rows:
                        if row.get('event_type') == 'artifact_scored' and row['axes'].startswith('D=7'):
                            row['axes'] = 'D=7 A=7 R=6 N=6'
                self.write_rows(rows)
                result = self.run_gate()
                self.assertIn('gate needs N>=4 per arm', result.stdout)
                self.assertTrue(self.staged.exists())

    def test_wrong_candidate_pin_cannot_trigger_early_cull(self):
        rows = self.one_pair(self.enable_pairs(['p5']))
        for row in rows:
            if row.get('event_type') == 'generation_context' and row['arm'] == 'staged':
                row['candidate_genome_sha256'] = '0' * 64
        self.write_rows(rows)
        self.assertEqual(paired_turns(scored_turns(self.trend, self.pins), ['p5']), [])
        result = self.run_gate()
        self.assertIn('gate needs N>=4 per arm', result.stdout)
        self.assertTrue(self.staged.exists())

    def test_mixed_panels_in_domain_do_not_trigger_early_cull(self):
        rows = self.enable_pairs(['p5'])
        second_pair = {r['artifact'] for r in rows if r.get('event_type') == 'generation_context'
                       and r['pair_id'] == 'p5-pair-1'}
        for row in rows:
            if row.get('event_type') == 'artifact_scored':
                if row['axes'].startswith('D=7'):
                    row['axes'] = 'D=7 A=7 R=4 N=4'
                if str(Path(row['artifact']).parent) in second_pair:
                    row['judges'] = ['other-a', 'other-b']
        self.write_rows(rows)
        result = self.run_gate()
        self.assertIn('paired model/panel changed in p5', result.stdout)
        self.assertTrue(self.staged.exists())

    def test_changed_genome_during_pin_recheck_prevents_deletion(self):
        raced = json.dumps([{'id': 'raced', 'text': 'Changed after scoring'}])
        for changed in (self.active, self.staged):
            with self.subTest(path=changed.name):
                self.active.write_text(json.dumps([{'id': 'old', 'text': 'Old rule'}]))
                self.staged.write_text(json.dumps([{'id': 'new', 'text': 'New rule'}]))

                def racing_digest(path):
                    if Path(path) == changed:
                        changed.write_text(raced)
                    return genome_digest(path)

                removed = remove_if_genomes_match(self.active, self.staged, self.pins, racing_digest)
                self.assertFalse(removed)
                self.assertEqual(changed.read_text(), raced)
                self.assertTrue(self.staged.exists())


if __name__ == "__main__":
    unittest.main()

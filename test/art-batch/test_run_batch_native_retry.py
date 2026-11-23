"""The native batch launcher retires partial receipts together with their artifacts."""
import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest


@pytest.fixture
def native_launcher(tmp_path):
    repo = Path(__file__).resolve().parents[2]
    config = tmp_path / '.sinter' / 'config.json'
    config.parent.mkdir()
    config.write_text(json.dumps({'providers': {'glm': {'apiKey': 'fixture'}}}))
    prompts = tmp_path / 'prompts.json'
    prompts.write_text(json.dumps({'prompts': [
        {'id': 'orbit', 'domain': 'p5', 'prompt': 'Orbit', 'seat': 'sol', 'loops': 2}
    ]}))
    node = tmp_path / '.local' / 'bin' / 'node'
    node.parent.mkdir(parents=True)
    node.write_text(f'#!{sys.executable}\n' + textwrap.dedent("""
        import hashlib
        import json
        from pathlib import Path
        import sys
        import time
        retry = '--retry-unknown' in sys.argv
        out = Path(sys.argv[sys.argv.index('-o') + 1])
        records = []
        for k in range(1, 3 if retry else 2):
            loop = out / 'loops' / f'r{k}'
            artifact = loop / 'artifacts' / 'piece'
            artifact.mkdir(parents=True)
            source = f"{'new' if retry else 'old'} r{k}"
            (artifact / 'source.txt').write_text(source)
            (artifact / 'medium.json').write_text(json.dumps({'medium_line': source, 'descriptor': {'name': f'layer-{k}'}}))
            records.append({'loop': k, 'outputRoot': str(loop), 'status': 'ok',
                            'score': 0.9 if retry else 0.6, 'revisedFrom': k - 1,
                            'winningAttempt': {'artifactSha256': hashlib.sha256(source.encode()).hexdigest()}})
        (out / 'loops-manifest.json').write_text(json.dumps({'records': records, 'bestLoop': 1}))
        if not retry:
            time.sleep(30)
    """))
    node.chmod(0o755)
    base = tmp_path / 's1ntr-art'
    base.mkdir()
    (base / 'learn_after_batch.py').write_text('pass\n')
    env = {'HOME': str(tmp_path), 'PATH': os.defpath, 'S1NTR_REPO': str(repo),
           'PROMPT_FILE': str(prompts), 'CHILD_TIMEOUT_S': '2'}
    launcher = textwrap.dedent('''
        import runpy
        import subprocess
        import sys

        node = sys.argv.pop(1)
        sys.argv.pop(0)
        popen = subprocess.Popen

        def start(command, *args, **kwargs):
            if command[0] == 'node':
                kwargs['executable'] = node
            return popen(command, *args, **kwargs)

        subprocess.Popen = start
        runpy.run_path(sys.argv[0], run_name='__main__')
    ''')
    command = [sys.executable, '-c', launcher, str(node),
               str(repo / 'scripts/art-batch/run_batch.py'), 'auto', 'file']
    def launch():
        return subprocess.run(command, env=env, capture_output=True, text=True, timeout=15)

    return launch, base / 'out' / 'sol62', node


def test_timeout_after_first_native_loop_then_retry(native_launcher):
    launch, out, _ = native_launcher
    first = launch()
    assert first.returncode == 1, first.stdout + first.stderr
    assert 'FAIL-CLASS timeout' in first.stdout
    r1 = out / 'orbit-r1'
    assert (r1 / 'artifacts' / 'piece' / 'source.txt').read_text() == 'old r1'
    choice = (out / 'orbit' / 'brief.info.json').read_bytes()
    learning = out.parents[1] / 'learning'
    learning.mkdir(exist_ok=True)
    (learning / 'motifs.jsonl').write_text(json.dumps({'domain': 'p5', 'name': 'new', 'line': 'a new shape'}) + '\n')
    rerun = launch()
    assert rerun.returncode == 0, rerun.stdout + rerun.stderr
    assert (r1 / 'artifacts' / 'piece' / 'source.txt').read_text() == 'new r1'
    first_manifest = json.loads((r1 / 'manifest.json').read_text())
    assert first_manifest['guidance'].get('reused') is True
    for folder in ('orbit', 'orbit-r1', 'orbit-r2'):
        assert (out / folder / 'brief.info.json').read_bytes() == choice
    assert first_manifest['loop_score'] == 0.9 and first_manifest['made_with'] == 'new r1'
    second_manifest = json.loads((out / 'orbit-r2' / 'manifest.json').read_text())
    assert second_manifest['made_with'] == 'new r2'
    assert second_manifest['medium_descriptor'] == {'name': 'layer-2'}
    retired, = (out.parent / '_superseded').iterdir()
    assert (retired / 'orbit-r1' / 'artifacts' / 'piece' / 'source.txt').read_text() == 'old r1'
    assert json.loads((retired / 'orbit-r1' / 'manifest.json').read_text())['loop_score'] == 0.6
    assert (out / 'orbit-r2' / 'artifacts' / 'piece' / 'source.txt').read_text() == 'new r2'


def test_legacy_output_collision_does_not_dispatch(native_launcher):
    launch, out, node = native_launcher
    legacy = out / 'orbit-r1'
    legacy.mkdir(parents=True)
    receipt = legacy / 'manifest.json'
    old = '{"model_key":"sol62","prompt_id":"orbit","rc":0}'
    receipt.write_text(old)
    marker = out / 'generate-called'
    node.write_text(f'#!{sys.executable}\nfrom pathlib import Path\nPath({str(marker)!r}).touch()\n')

    result = launch()
    assert result.returncode == 1, result.stdout + result.stderr
    assert 'LOOP-DESTINATION-CONFLICT' in result.stdout and 'OUT_TAG' in result.stdout
    assert not marker.exists()
    assert receipt.read_text() == old

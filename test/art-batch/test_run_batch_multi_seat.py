"""Exercise repeated revision loops and learning for both seats without model calls."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


@pytest.mark.parametrize('resume', [False, True])
def test_repeat_tag_keeps_each_loop_and_learns_each_seat(tmp_path, resume):
    repo = Path(__file__).resolve().parents[2]
    legacy = tmp_path / 'legacy'
    (legacy / 'bin').mkdir(parents=True)
    (legacy / 'bin' / 'sinter').write_text("'--revise-from'\n'--attempt'\n")
    subprocess.run(['git', 'init', '-q', str(legacy)], check=True, timeout=10)
    subprocess.run(['git', '-C', str(legacy), '-c', 'user.name=Batch Test',
                    '-c', 'user.email=batch@example.test', 'commit', '-q', '--allow-empty',
                    '-m', 'Fixture'], check=True, timeout=10)
    config = tmp_path / '.sinter' / 'config.json'
    config.parent.mkdir()
    config.write_text(json.dumps({'providers': {'glm': {'apiKey': 'fake'}}}))
    work = tmp_path / 's1ntr-art'
    work.mkdir()
    prompts = work / 'prompts.json'
    prompts.write_text(json.dumps({'prompts': [
        {'id': 'revision', 'domain': 'p5', 'prompt': 'Test revision', 'seat': 'sol', 'loops': 2},
        {'id': 'other', 'domain': 'p5', 'prompt': 'Test peer', 'seat': 'astra', 'loops': 1},
    ]}))
    node = tmp_path / '.local' / 'bin' / 'node'
    node.parent.mkdir(parents=True)
    node.write_text(f'#!{sys.executable}\n'
                    'from pathlib import Path\nimport sys\n'
                    'out = Path(sys.argv[sys.argv.index("-o") + 1])\n'
                    '(out / "artifacts" / "fake").mkdir(parents=True)\n')
    node.chmod(0o755)
    (work / 'learn_after_batch.py').write_text(
        'from pathlib import Path\nimport sys\n'
        'with Path(__file__).with_name("learned").open("a") as log:\n'
        '    log.write(sys.argv[1] + "\\n")\n'
    )
    env = {'HOME': str(tmp_path), 'PATH': os.defpath, 'S1NTR_REPO': str(legacy),
           'PROMPT_FILE': str(prompts), 'REP': '-r7', 'CHILD_TIMEOUT_S': '10'}
    command = [sys.executable, str(repo / 'scripts/art-batch/run_batch.py'), 'auto', 'file']
    seat = work / 'out' / 'sol62'
    first, second = seat / 'revision-r7', seat / 'revision-r7-loop2'
    if resume:
        subprocess.run([*command, 'revision'], env=dict(env, LOOPS='1'), check=True,
                       capture_output=True, text=True, timeout=25)
        previous_manifest = (first / 'manifest.json').read_bytes()
        (work / 'learned').write_text('')
    result = subprocess.run(command, env=env, check=True, capture_output=True, text=True, timeout=25)
    if resume:
        assert 'loop 1/2 already complete' in result.stdout
        assert (first / 'manifest.json').read_bytes() == previous_manifest
    assert json.loads((second / 'manifest.json').read_text())['revised_from'] == first.name
    requests = {path: json.loads((path / 'request-argv.json').read_text()) for path in (first, second)}
    assert requests[first][requests[first].index('--attempt') + 1] != requests[second][requests[second].index('--attempt') + 1]
    assert (work / 'out' / 'astra62' / 'other-r7' / 'manifest.json').is_file()
    assert (work / 'learned').read_text().splitlines() == ['astra62', 'sol62']

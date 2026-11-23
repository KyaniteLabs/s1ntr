"""Funded seat caps count every scheduled piece before configuration or dispatch."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


@pytest.mark.parametrize(('loops', 'override', 'seat', 'expected'), [
    ([7, 7], None, 'astra', '14 planned pieces exceed the cap of 13'),
    ([1, 1, 1, 1], '10', 'sol', '40 planned pieces exceed the cap of 39'),
    ([False], None, 'sol', 'loops must be a positive integer'),
    ([0], None, 'sol', 'loops must be a positive integer'),
    ([1.5], None, 'sol', 'loops must be a positive integer'),
    ([1], '-1', 'sol', 'loops must be a positive integer'),
    ([1, 13], None, 'astra', 'native --loops supports at most 12 pieces per prompt'),
])
def test_rejects_over_cap_or_invalid_loop_plan(tmp_path, loops, override, seat, expected):
    repo = Path(__file__).resolve().parents[2]
    config = tmp_path / '.sinter' / 'config.json'
    config.parent.mkdir()
    config.write_text(json.dumps({'providers': {'glm': {'apiKey': 'fixture'}}}))
    prompts = tmp_path / 'prompts.json'
    prompts.write_text(json.dumps({'prompts': [
        {'id': f'piece-{index}', 'domain': 'p5', 'prompt': 'Orbit', 'seat': 'sol' if loops == [1, 13] and index == 0 else seat, 'loops': count}
        for index, count in enumerate(loops)
    ]}))
    node = tmp_path / '.local' / 'bin' / 'node'
    node.parent.mkdir(parents=True)
    called = tmp_path / 'dispatched'
    node.write_text(f'#!{sys.executable}\nfrom pathlib import Path\nPath({str(called)!r}).touch()\n')
    node.chmod(0o755)
    env = {'HOME': str(tmp_path), 'PATH': os.defpath, 'S1NTR_REPO': str(repo), 'PROMPT_FILE': str(prompts)}
    if override is not None:
        env['LOOPS'] = override
    result = subprocess.run(
        [sys.executable, str(repo / 'scripts/art-batch/run_batch.py'), 'auto', 'file'],
        cwd=tmp_path, env=env, capture_output=True, text=True, timeout=10,
    )
    assert result.returncode != 0
    assert expected in result.stderr
    assert not called.exists()
    assert not (tmp_path / 's1ntr-art' / 'out').exists()

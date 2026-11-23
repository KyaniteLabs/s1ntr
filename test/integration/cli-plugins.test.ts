/** Dogfood finding 6 (plugins): `sinter plugins` was not a command. Now a read-only admission audit plus a pin step. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { isolatedCliEnv } from '../helpers/isolatedCli.js';
import { runSinterAsync } from '../helpers/fakeProviderServer.js';

const { env, home } = isolatedCliEnv();
afterAll(() => rmSync(home, { recursive: true, force: true }));
vi.setConfig({ testTimeout: 120_000 });
const work = mkdtempSync(path.join(tmpdir(), 'sinter-plugins-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const dir = path.join(work, 'plugins');
const run = (args: string[]) => runSinterAsync([...args, '--plugins-dir', dir], env, work);

describe('sinter plugins', () => {
  it('lists plugins, shows execution is refused by default, pins, admits, and refuses after the bytes change', async () => {
    mkdirSync(path.join(dir, 'demo'), { recursive: true });
    writeFileSync(path.join(dir, 'demo', 'plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', entry: 'index.js', domains: ['html'] }));
    writeFileSync(path.join(dir, 'demo', 'index.js'), 'export function generate() { return "<html></html>"; }\n');
    const before = await run(['plugins', 'status']);
    expect(before.status).toBe(0);
    expect(before.out).toContain('Execution: refused. Status checks admission only.');
    expect(before.out).toMatch(/demo\s+unpinned\s+domains: html/);
    expect(before.out).toContain('Pin one with: sinter plugins pin <id>');
    const pin = await run(['plugins', 'pin', 'demo']);
    expect(pin.status).toBe(0);
    expect((await run(['plugins', 'status'])).out).toMatch(/demo\s+admitted/);
    appendFileSync(path.join(dir, 'demo', 'index.js'), '// tampered\n');
    expect((await run(['plugins', 'status'])).out).toMatch(/demo\s+refused \(PINNED_PLUGIN_BINDING_INVALID\)/);
  });
  it('pin of an unknown plugin exits 1 with the reason', async () => {
    const r = await run(['plugins', 'pin', 'nope']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('Cannot pin "nope"');
  });
  it('confines pins and plugin entries to the selected plugin directory', async () => {
    const outside = path.join(work, 'outside');
    const plugin = path.join(dir, 'linked');
    mkdirSync(outside, { recursive: true });
    mkdirSync(plugin, { recursive: true });
    writeFileSync(path.join(outside, 'other.js'), 'outside entry');
    writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify({ id: 'linked', entry: 'entry.js', domains: ['html'] }));
    symlinkSync(path.join(outside, 'other.js'), path.join(plugin, 'entry.js'));
    expect((await run(['plugins', 'pin', '../outside'])).status).toBe(1);
    expect(existsSync(path.join(outside, 'plugin.pinned.json'))).toBe(false);
    expect((await run(['plugins', 'pin', 'linked'])).out).toContain('PLUGIN_FILE_LINK_REFUSED');
    expect(readFileSync(path.join(outside, 'other.js'), 'utf8')).toBe('outside entry');
  });
  it('the install ships plugins that show up in status', async () => {
    const r = await runSinterAsync(['plugins', 'status'], env, work);
    expect(r.out).toMatch(/Plugins in \S+: [1-9]/);
  });
});

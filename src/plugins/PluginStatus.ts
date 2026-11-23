/**
 * Operator view of the plugins folder: which plugins exist, which are pinned, and whether the governed gate
 * would admit each one. Nothing here executes plugin code (admission reads the entry bytes only).
 */
import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { writeFileAtomicSync } from '../utils/atomicWrite.js';
import { assertSafeSegment, normalizePath } from '../utils/normalizePath.js';
import { GovernedPluginGate, createPinnedPluginManifest, createPluginOperationAuthority,
  type PinnedPluginManifest } from './GovernedPluginGate.js';

export interface PluginStatusRow {
  readonly id: string;
  readonly domains: readonly string[];
  readonly pinned: boolean;
  readonly admission: 'admitted' | 'unpinned' | `refused ${string}`;
}

interface PluginManifest { id: string; entry: string; version?: string; domains: string[] }

function readPluginFile(dir: string, name: string): string {
  if (path.isAbsolute(name)) throw new Error('PLUGIN_FILE_OUTSIDE_DIRECTORY');
  const file = normalizePath(dir, name);
  if (!file.startsWith(dir + path.sep)) throw new Error('PLUGIN_FILE_OUTSIDE_DIRECTORY');
  if (realpathSync(file) !== file) throw new Error('PLUGIN_FILE_LINK_REFUSED');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('PLUGIN_FILE_NOT_REGULAR');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

function readManifest(dir: string, id: string): PluginManifest {
  const manifest = JSON.parse(readPluginFile(dir, 'plugin.json')) as Partial<PluginManifest>;
  if (!manifest || manifest.id !== id || typeof manifest.entry !== 'string'
    || !Array.isArray(manifest.domains) || manifest.domains.length === 0
    || !manifest.domains.every(domain => typeof domain === 'string' && domain.trim())) {
    throw new Error('PLUGIN_MANIFEST_INVALID');
  }
  return { id, entry: manifest.entry, version: manifest.version, domains: manifest.domains };
}

export function inspectPlugins(pluginsDir: string): PluginStatusRow[] {
  if (!existsSync(pluginsDir)) return [];
  const root = realpathSync(pluginsDir);
  const rows: PluginStatusRow[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const id = entry.name;
    const dir = path.join(root, id);
    let manifest: PluginManifest;
    try {
      assertSafeSegment(id, 'Plugin ID');
      if (realpathSync(dir) !== dir) throw new Error('PLUGIN_DIRECTORY_LINK_REFUSED');
      manifest = readManifest(dir, id);
    } catch {
      rows.push({ id, domains: [], pinned: false, admission: 'refused (plugin.json unreadable)' });
      continue;
    }
    const pinFile = path.join(dir, 'plugin.pinned.json');
    if (!existsSync(pinFile)) { rows.push({ id, domains: manifest.domains ?? [], pinned: false, admission: 'unpinned' }); continue; }
    try {
      const pin = JSON.parse(readPluginFile(dir, 'plugin.pinned.json')) as PinnedPluginManifest;
      if (pin.id !== id) throw new Error('PINNED_PLUGIN_BINDING_INVALID');
      const source = readPluginFile(dir, manifest.entry);
      const authority = createPluginOperationAuthority();
      const capability = authority.issue({ operationId: `status:${id}`, pluginId: pin.id, manifestDigest: pin.manifestDigest,
        domain: pin.domains[0] as never, expiresAt: Date.now() + 60_000 });
      new GovernedPluginGate(authority.assert).admit(pin, capability, source);
      rows.push({ id, domains: pin.domains, pinned: true, admission: 'admitted' });
    } catch (e) {
      rows.push({ id, domains: manifest.domains ?? [], pinned: true, admission: `refused (${e instanceof Error ? e.message : 'error'})` });
    }
  }
  return rows;
}

/** Pin the exact bytes of a plugin's entry file; the governed gate admits only what is pinned. */
export function pinPlugin(pluginsDir: string, id: string): string {
  assertSafeSegment(id, 'Plugin ID');
  if (!id.trim() || id === '.') throw new Error('PLUGIN_ID_INVALID');
  const dir = path.join(realpathSync(pluginsDir), id);
  if (realpathSync(dir) !== dir) throw new Error('PLUGIN_DIRECTORY_LINK_REFUSED');
  const manifest = readManifest(dir, id);
  const source = readPluginFile(dir, manifest.entry);
  const pinned = createPinnedPluginManifest({ id: manifest.id, version: manifest.version ?? '0.0.0',
    entryDigest: createHash('sha256').update(source).digest('hex'), domains: manifest.domains as never });
  const file = path.join(dir, 'plugin.pinned.json');
  writeFileAtomicSync(file, `${JSON.stringify(pinned, null, 2)}\n`);
  return file;
}

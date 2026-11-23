/**
 * SeedArchive - Seed generation and storage functionality
 *
 * Manages unique seed generation and persistent storage of seed metadata.
 * Seeds are used to recreate generative art outputs with consistent parameters.
 *
 * Key behavior:
 * - generateSeed() creates unique lowercase alphanumeric strings
 * - saveSeed(seed, metadata) saves seed metadata to archive/{seed}.json
 * - loadSeed(seed) loads seed metadata or returns null if not found
 */

import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { assertSafeSegment } from '../utils/normalizePath.js';

export interface SeedMetadata {
  [key: string]: unknown;
}

export interface SeedData extends SeedMetadata {
  seed: string;
}

export class SeedArchive {
  private readonly archiveDir: string;

  constructor(archiveDir: string = 'seeds') {
    this.archiveDir = archiveDir;
  }

  /**
   * Generate a unique seed string
   * @returns Unique lowercase alphanumeric seed with hyphens
   */
  generateSeed(): string {
    const bytes = randomBytes(16);
    const seed = bytes.toString('base64')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    return seed.substring(0, Math.min(seed.length, 32));
  }

  /**
   * Save seed with metadata to archive
   * @param seed - Seed string (must be non-empty string)
   * @param metadata - Metadata object to store with seed
   * @throws Error if validation fails or file system error occurs
   */
  async saveSeed(seed: string, metadata: SeedMetadata): Promise<void> {
    if (!seed || typeof seed !== 'string' || seed.trim() === '') {
      throw new Error('Seed is required and must be a non-empty string');
    }
    assertSafeSegment(seed, 'Seed');

    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('Metadata is required and must be an object');
    }

    const seedData: SeedData = {
      ...metadata,
      seed
    };

    try {
      await fs.mkdir(this.archiveDir, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create archive directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    const filename = `${seed}.json`;
    const filepath = path.join(this.archiveDir, filename);
    // Validate the resolved path stays within archiveDir
    const resolved = path.resolve(this.archiveDir);
    const resolvedFile = path.resolve(filepath);
    if (!resolvedFile.startsWith(resolved + path.sep) && resolvedFile !== resolved) {
      throw new Error('Seed path must be within archive directory');
    }

    try {
      await fs.writeFile(filepath, JSON.stringify(seedData, null, 2), 'utf-8');
    } catch (error) {
      throw new Error(`Failed to save seed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Load seed metadata from archive
   * @param seed - Seed string (must be non-empty string)
   * @returns Seed data with metadata, or null if not found
   * @throws Error if validation, decoding, or reading an existing entry fails
   */
  async loadSeed(seed: string): Promise<SeedData | null> {
    if (!seed || typeof seed !== 'string' || seed.trim() === '') {
      throw new Error('Seed is required and must be a non-empty string');
    }
    assertSafeSegment(seed, 'Seed');

    const filename = `${seed}.json`;
    const filepath = path.join(this.archiveDir, filename);
    // Validate the resolved path stays within archiveDir
    const resolved = path.resolve(this.archiveDir);
    const resolvedFile = path.resolve(filepath);
    if (!resolvedFile.startsWith(resolved + path.sep) && resolvedFile !== resolved) {
      throw new Error('Seed path must be within archive directory');
    }

    let content: string;
    try {
      content = await fs.readFile(filepath, 'utf-8');
    } catch (readError) {
      if (readError && typeof readError === 'object'
        && 'code' in readError && readError.code === 'ENOENT') return null;
      throw readError;
    }
    let data: unknown;
    try { data = JSON.parse(content); }
    catch (cause) { throw new Error('Invalid seed archive JSON', { cause }); }
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || !Object.hasOwn(data, 'seed') || Reflect.get(data, 'seed') !== seed) {
      throw new Error('Seed archive entry does not match requested seed');
    }
    return data as SeedData;
  }

  /**
   * Every entry in the archive, oldest file name first. A missing archive is an empty list; an entry that
   * does not parse is skipped (one damaged file must not hide the rest).
   */
  async listSeeds(prefix = ''): Promise<SeedData[]> {
    let names: string[];
    try { names = await fs.readdir(this.archiveDir); } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    const out: SeedData[] = [];
    for (const name of names.filter(n => n.startsWith(prefix) && n.endsWith('.json')).sort()) {
      try {
        const entry = await this.loadSeed(name.slice(0, -'.json'.length));
        if (entry) out.push(entry);
      } catch { /* skip a damaged entry */ }
    }
    return out;
  }
}

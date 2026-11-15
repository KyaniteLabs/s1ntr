/**
 * FABLE-3.5: Studio's preview page inlines user code into a <script> element.
 * The HTML parser closes that element at `</script` followed by whitespace,
 * `/` or `>` in any case — so `</script >` or `</SCRIPT\n>` must be escaped
 * too, not only the literal `</script>`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';

const realFetch = globalThis.__liminalNativeFetch || globalThis.fetch.bind(globalThis);

async function preview(port, code, version) {
  const post = await realFetch(`http://127.0.0.1:${port}/api/preview/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, version }),
  });
  expect(post.status).toBe(200);
  await post.text();
  const res = await realFetch(`http://127.0.0.1:${port}/preview?version=${version}`);
  return { status: res.status, html: await res.text() };
}

describe('Studio preview escapes every script-closing form', () => {
  let server;
  let port;
  let dir;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-escape-'));
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, '{}', 'utf-8');
    process.env.LIMINAL_CONFIG_PATH = configPath;
    delete process.env.SINTER_GUI_TOKEN;
    delete process.env.LIMINAL_GUI_TOKEN;
    const { createApp } = await import('../../gui/server.js');
    server = http.createServer(createApp(configPath));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  }, 120000);

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    delete process.env.LIMINAL_CONFIG_PATH;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['space before >', 'const s = "</script ><img src=x onerror=alert(1)>";', '</script ><img'],
    ['upper case + newline', 'const s = "</SCRIPT\n><img src=x onerror=alert(1)>";', '</SCRIPT\n><img'],
    ['slash', 'const s = "</script/><img src=x onerror=alert(1)>";', '</script/><img'],
  ])('neutralises a closing tag with %s', async (_label, code, raw) => {
    const { status, html } = await preview(port, code, 41 + raw.length);
    expect(status).toBe(200);
    expect(html.includes(raw)).toBe(false);
    expect(html).toContain('<\\/');
  });

  it('leaves code without a closing tag byte-identical', async () => {
    const code = 'function setup(){ createCanvas(32, 32); text("a < b", 4, 16); }';
    const { status, html } = await preview(port, code, 90);
    expect(status).toBe(200);
    expect(html).toContain(code);
  });
});

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapHostAuthority,
  pinnedProductionHostAuthorityRoot,
} from '../../../src/identity/executorAuthorityBootstrap.js';

export const INTEGRATION_PROOF_MODEL = 'lmstudio/sinter-integration-proof-model';

const ENV_KEYS = [
  'LIMINAL_LLM_PROVIDER',
  'LIMINAL_LLM_BASE_URL',
  'LIMINAL_LLM_MODEL',
  'LIMINAL_LLM_API_KEY',
  'LIMINAL_ALLOW_LOCALHOST_LLM',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_API_KEY',
  'LIMINAL_EVALUATOR_BASE_URL',
  'LIMINAL_EVALUATOR_MODEL',
  'LIMINAL_EVALUATOR_API_KEY',
  'LIMINAL_HARNESS_BASE_URL',
  'LIMINAL_HARNESS_MODEL',
  'LIMINAL_HARNESS_API_KEY',
  'SINTER_EXECUTOR_AUTHORITY_ROOT',
  'SINTER_METERED_APPROVED_USD_CEILING',
  'SINTER_METERED_PRICE_RECEIPT_DIGEST',
  'HOME',
];

async function readJsonBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function promptFromBody(body) {
  if (Array.isArray(body?.messages)) {
    return body.messages
      .map((message) => typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? ''))
      .join('\n');
  }
  return JSON.stringify(body ?? {});
}

function p5SketchForPrompt(prompt, requestIndex) {
  const includePromise = prompt.includes('<promise>COMPLETE</promise>');
  const hue = (requestIndex * 37) % 360;
  return `// integration proof sketch ${requestIndex}
// particle system animation moving interactive mouse cellular automata grid cells
${includePromise ? '// <promise>COMPLETE</promise>' : ''}
let particles = [];
let cells = [];

function setup() {
  createCanvas(640, 420);
  colorMode(HSB, 360, 100, 100, 100);
  rectMode(CENTER);
  textStyle(NORMAL);
  for (let i = 0; i < 24; i++) {
    particles.push(new Particle(i));
    cells.push((i + ${requestIndex}) % 2);
  }
}

function draw() {
  background(${hue}, 28, 12);
  const pulse = millis() / 1000;
  const radius = 38 + sin(radians(frameCount * 3 + ${requestIndex})) * 18;
  stroke(180, 50, 90);
  point(width / 2 + cos(pulse) * radius, height / 2 + sin(pulse) * radius);

  for (const particle of particles) {
    particle.update();
    particle.display();
  }

  for (let i = 0; i < cells.length; i++) {
    fill((i * 17 + frameCount + ${hue}) % 360, 45, cells[i] ? 85 : 35);
    rect(24 + i * 24, height - 28, 14, 14);
  }

  if (mouseIsPressed) {
    fill(45, 80, 95);
    ellipse(mouseX, mouseY, radius);
  }

  fill(0, 0, 100);
  textStyle(BOLD);
  text('animation frame ' + nf(frameCount, 3), 16, 24);
  textStyle(NORMAL);
}

class Particle {
  constructor(index) {
    this.index = index;
    this.x = random(width);
    this.y = random(height);
    this.vx = random(-1.7, 1.7);
    this.vy = random(-1.7, 1.7);
  }

  update() {
    this.x += this.vx;
    this.y += this.vy;
    if (this.x < 0 || this.x > width) this.vx *= -1;
    if (this.y < 0 || this.y > height) this.vy *= -1;
  }

  display() {
    noStroke();
    fill((${hue} + this.index * 9 + frameCount) % 360, 70, 92, 78);
    ellipse(this.x, this.y, 8 + (this.index % 5));
  }
}
`;
}

function evaluatorJson(requestIndex) {
  const score = 0.72 + ((requestIndex % 6) * 0.035);
  return JSON.stringify({
    score,
    confidence: 0.92,
    technical: Math.min(0.95, score + 0.02),
    creative: Math.min(0.95, score + 0.01),
    novelty: Math.max(0.65, score - 0.04),
    reasoning: 'Deterministic integration proof evaluator: visible, syntactically valid artifact with motion and interaction cues.',
    suggestions: [],
    repairAdvice: null,
  });
}

// Route on the system prompt: generation prompts embed a random compost seed,
// and a seed whose text says "Acceptance Criteria:" must not get judge JSON.
function routingTextFromBody(body) {
  if (Array.isArray(body?.messages)) {
    const system = body.messages.filter((message) => message?.role === 'system');
    if (system.length > 0) return promptFromBody({ messages: system });
  }
  return promptFromBody(body);
}

function contentForPrompt(routingText, prompt, requestIndex) {
  if (/expert creative artifact evaluator|Return ONLY a JSON object|Criteria:/i.test(routingText)) {
    return evaluatorJson(requestIndex);
  }
  return p5SketchForPrompt(prompt, requestIndex);
}

export function startIntegrationProofLLMServer() {
  const requests = [];
  const control = { forceStatus: 0 };
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void (async () => {
        if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
          writeJson(res, 200, { object: 'list', data: [{ id: INTEGRATION_PROOF_MODEL, object: 'model' }] });
          return;
        }

        if (req.method !== 'POST' || (req.url !== '/v1/chat/completions' && req.url !== '/chat/completions')) {
          writeJson(res, 404, { error: 'not found' });
          return;
        }

        const body = await readJsonBody(req);
        requests.push(body);
        if (control.forceStatus) {
          writeJson(res, control.forceStatus, { error: { message: 'integration proof forced failure', type: 'invalid_request_error' } });
          return;
        }
        const prompt = promptFromBody(body);
        const content = contentForPrompt(routingTextFromBody(body), prompt, requests.length);
        writeJson(res, 200, {
          id: `chatcmpl-sinter-integration-${requests.length}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: INTEGRATION_PROOF_MODEL,
          choices: [{
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 32, completion_tokens: 256, total_tokens: 288 },
        });
      })().catch((error) => {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('Failed to allocate integration proof model port'));
        return;
      }
      const port = address.port;
      resolve({
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        control,
        close: () => new Promise((closeResolve) => server.close(() => closeResolve())),
      });
    });
    server.on('error', reject);
  });
}

export async function installIntegrationProofLLMEnv() {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const proof = await startIntegrationProofLLMServer();
  const isolatedHome = mkdtempSync(join(tmpdir(), 'sinter-proof-home-'));
  process.env.HOME = isolatedHome;
  process.env.SINTER_EXECUTOR_AUTHORITY_ROOT = pinnedProductionHostAuthorityRoot();
  bootstrapHostAuthority({ rootDir: process.env.SINTER_EXECUTOR_AUTHORITY_ROOT });
  const applyEnv = () => {
    process.env.LIMINAL_LLM_PROVIDER = 'openai';
    process.env.LIMINAL_LLM_BASE_URL = proof.baseUrl;
    process.env.LIMINAL_LLM_MODEL = INTEGRATION_PROOF_MODEL;
    process.env.LIMINAL_LLM_API_KEY = 'sinter-integration-proof-key';
    // Loopback proof server is intentional; SSRF still blocks arbitrary private IPs.
    process.env.LIMINAL_ALLOW_LOCALHOST_LLM = 'true';
    process.env.LLM_BASE_URL = proof.baseUrl;
    process.env.LLM_MODEL = INTEGRATION_PROOF_MODEL;
    process.env.LLM_API_KEY = 'sinter-integration-proof-key';
    // Evaluator and harness roles resolve their own endpoint; without these a
    // role file (~/.sinter/config.json) would send judge calls to a real provider.
    for (const role of ['EVALUATOR', 'HARNESS']) {
      process.env[`LIMINAL_${role}_BASE_URL`] = proof.baseUrl;
      process.env[`LIMINAL_${role}_MODEL`] = INTEGRATION_PROOF_MODEL;
      process.env[`LIMINAL_${role}_API_KEY`] = 'sinter-integration-proof-key';
    }
    process.env.SINTER_METERED_APPROVED_USD_CEILING = '1';
    process.env.SINTER_METERED_PRICE_RECEIPT_DIGEST = 'integration-proof-metered-receipt';
  };
  applyEnv();

  const cleanup = async () => {
    await proof.close();
    rmSync(isolatedHome, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  // Suites whose setup file clears LLM env per test call this to restore it.
  cleanup.reapply = applyEnv;
  // Make every later request fail with this HTTP status; 0 restores normal answers.
  cleanup.failWith = (status) => { proof.control.forceStatus = status; };
  return cleanup;
}

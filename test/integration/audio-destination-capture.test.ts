import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { audioCapturePageInit } from '../../src/render/HeadlessRenderer.js';
import { chromiumLaunchOptions } from '../../src/utils/browserPreflight.js';

// Real-browser gate: the capture tap must follow what reaches the speakers.
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ ...chromiumLaunchOptions(),
    args: ['--autoplay-policy=no-user-gesture-required'] });
});
afterAll(async () => { await browser?.close(); });

it.each([0, 0.1])('captures final gain %s, preserving AudioParam overloads', async gain => {
  const page = await browser.newPage();
  await page.addInitScript(audioCapturePageInit, 16384);
  await page.goto('data:text/html,<title>Audio capture control</title>');
  await page.evaluate(async value => {
    const ctx = new AudioContext({ sampleRate: 44100 });
    const oscillator = ctx.createOscillator(), output = ctx.createGain();
    output.gain.value = value;
    oscillator.connect(ctx.createGain().gain);
    oscillator.connect(output);
    output.connect(ctx.destination);
    oscillator.start();
    await ctx.resume();
  }, gain);
  await page.waitForTimeout(1500);
  const samples = await page.evaluate(() =>
    (window as unknown as { __audioCaptureData: number[] }).__audioCaptureData);
  const peak = Math.max(0, ...samples.map(Math.abs));
  if (gain === 0) expect(peak).toBe(0);
  else {
    expect(samples.length).toBeGreaterThan(1000);
    expect(peak).toBeGreaterThan(0.09);
    expect(peak).toBeLessThan(0.11);
  }
  await page.close();
});

it('captures a chain that ends in a compressor, and stops after disconnect', async () => {
  const page = await browser.newPage();
  await page.addInitScript(audioCapturePageInit, 1 << 20);
  await page.goto('data:text/html,<title>Audio capture compressor</title>');
  const samples = () => page.evaluate(() =>
    (window as unknown as { __audioCaptureData: number[] }).__audioCaptureData.length);
  await page.evaluate(async () => {
    const ctx = new AudioContext({ sampleRate: 44100 });
    const oscillator = ctx.createOscillator();
    const compressor = new DynamicsCompressorNode(ctx);
    oscillator.connect(compressor);
    compressor.connect(ctx.destination);
    (window as unknown as { __compressor: AudioNode }).__compressor = compressor;
    oscillator.start();
    await ctx.resume();
  });
  await page.waitForTimeout(1000);
  const peak = await page.evaluate(() => Math.max(0,
    ...(window as unknown as { __audioCaptureData: number[] }).__audioCaptureData.map(Math.abs)));
  expect(peak).toBeGreaterThan(0.05);
  await page.evaluate(() => (window as unknown as { __compressor: AudioNode }).__compressor.disconnect());
  await page.waitForTimeout(300);
  const before = await samples();
  await page.waitForTimeout(700);
  const tail = await page.evaluate(n => Math.max(0,
    ...(window as unknown as { __audioCaptureData: number[] }).__audioCaptureData.slice(n).map(Math.abs)), before);
  expect(tail).toBe(0);
  await page.close();
});

it.each([0, 0.1])('detects whether the extra context with gain %s made the take incomplete', async gain => {
  const page = await browser.newPage();
  try {
    await page.addInitScript(audioCapturePageInit, 16384);
    await page.goto('data:text/html,<title>Multiple audio contexts</title>');
    await page.evaluate(async secondaryGain => {
      for (const amplitude of [0.1, secondaryGain]) {
        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const output = ctx.createGain();
        output.gain.value = amplitude;
        oscillator.connect(output);
        output.connect(ctx.destination);
        oscillator.start();
        await ctx.resume();
      }
    }, gain);
    await page.waitForTimeout(600);
    const invalid = await page.evaluate(() =>
      (window as unknown as { __audioCaptureIncomplete?: boolean }).__audioCaptureIncomplete === true);
    expect(invalid).toBe(gain !== 0);
  } finally { await page.close(); }
});

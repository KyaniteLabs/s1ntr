#!/usr/bin/env node
/**
 * Debug harness for RevideoRenderer.
 * Renders a minimal 1-second scene to reproduce/fix the vite tooling hang.
 */

import fs from 'fs';
import path from 'path';
import { RevideoRenderer } from '../../dist/render/RevideoRenderer.js';

const scene = `
import { makeScene2D } from '@revideo/2d';
import { Circle } from '@revideo/2d';
import { createRef } from '@revideo/2d';
import { waitFor } from '@revideo/core';

export default makeScene2D(function* (view) {
  const circle = createRef<Circle>();
  view.add(<Circle ref={circle} width={100} height={100} fill="#e13238" />);
  yield* waitFor(1);
});
`;

const outDir = '.quality/renders/.revideo-debug';
const outputPath = path.join(outDir, 'debug.mp4');
fs.mkdirSync(outDir, { recursive: true });

const renderer = new RevideoRenderer({ tempDir: outDir });
console.log('Starting revideo render...');
renderer
  .render(scene, outputPath, {
    fps: 30,
    width: 640,
    height: 360,
    logProgress: true,
    progressCallback: (worker, progress) => console.log(`progress[worker=${worker}]: ${(progress * 100).toFixed(1)}%`),
  })
  .then((result) => {
    console.log('SUCCESS:', result);
  })
  .catch((err) => {
    console.error('FAILURE:', err.message);
    if (err.cause) console.error('CAUSE:', err.cause);
    process.exit(1);
  });

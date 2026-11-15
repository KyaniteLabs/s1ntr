/** RenderPort over the proven HeadlessRenderer (string-code path, html domain). */
import { HeadlessRenderer } from '../render/HeadlessRenderer.js';
import type { RenderPort } from './CycleDriver.js';

export class HeadlessRendererAdaptor implements RenderPort {
  private renderer: HeadlessRenderer | null = null;

  private async ensure(): Promise<HeadlessRenderer> {
    if (!this.renderer) {
      this.renderer = new HeadlessRenderer();
      await this.renderer.initialize();
    }
    return this.renderer;
  }

  async renderHtml(html: string): Promise<{ succeeded: boolean; runtimeErrors: number; renderMs: number; screenshotBase64?: string }> {
    const renderer = await this.ensure();
    const startedAt = Date.now();
    try {
      const result = await renderer.render(html, { domain: 'html', timeout: 20000 });
      return {
        succeeded: result.success,
        runtimeErrors: result.errors.length,
        renderMs: Date.now() - startedAt,
        screenshotBase64: result.screenshot?.buffer?.toString('base64'),
      };
    } catch {
      return { succeeded: false, runtimeErrors: 1, renderMs: Date.now() - startedAt };
    }
  }
}

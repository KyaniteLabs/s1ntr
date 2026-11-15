import { Tool, type ToolResult } from './types.js';
import {
  loadImageAttachment,
  attachmentReceipt,
  type ImageAttachment,
} from '../../media/ImageAttachment.js';

export interface AttachImageParams {
  path: string;
  role?: ImageAttachment['role'];
}

/**
 * Sole owner of harness image attach (UMD-V2 I2).
 * Does not send to the model itself — caller attaches to next planning vision channel.
 */
export class AttachImageTool extends Tool {
  readonly name = 'attachImage';
  readonly description =
    'Load an image from a path into a staged ImageAttachment for the next vision-capable planning call. Params: {"path":"fixture.png","role":"reference"}. Never logs base64.';

  async execute(params: unknown): Promise<ToolResult<{ attachment: ImageAttachment; receipt: ReturnType<typeof attachmentReceipt> }>> {
    // Keep async for Tool contract; force a microtask so require-await is satisfied.
    await Promise.resolve();
    const p = (params || {}) as AttachImageParams;
    if (typeof p.path !== 'string' || !p.path.trim()) {
      return { success: false, error: 'attachImage requires params.path' };
    }
    try {
      const attachment = loadImageAttachment(p.path.trim(), {
        source: 'harness-tool',
        role: p.role ?? 'reference',
        allowRoots: [process.cwd()],
      });
      return {
        success: true,
        data: {
          attachment,
          receipt: attachmentReceipt(attachment, { seat: 'harness', visionCapable: null }),
        },
      };
    } catch (e) {
      const err = e as Error & { code?: string };
      return { success: false, error: err.message || String(e) };
    }
  }
}

export const attachImageTool = new AttachImageTool();

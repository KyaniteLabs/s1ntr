import { describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { writeSse } from '../../../src/tui-bridge/TuiBridgeServer.js';

function makeRes(overrides: Partial<ServerResponse> & { write?: () => boolean } = {}) {
  const res = {
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
    write: vi.fn(() => false),
    destroy: vi.fn(),
    ...overrides,
  };
  return res as unknown as ServerResponse & { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
}

describe('writeSse', () => {
  it('treats write() === false as backpressure, not disconnect', () => {
    const res = makeRes({ write: vi.fn(() => false) });
    expect(writeSse(res, 'data: x\n\n')).toBe(true);
    expect(res.write).toHaveBeenCalledOnce();
    expect(res.destroy).not.toHaveBeenCalled();
  });

  it('stops when the client is already gone', () => {
    const res = makeRes({ destroyed: true });
    expect(writeSse(res, 'data: x\n\n')).toBe(false);
    expect(res.write).not.toHaveBeenCalled();
  });

  it('drops a client buffered past the cap', () => {
    const res = makeRes({ writableLength: 2 * 1024 * 1024 });
    expect(writeSse(res, 'data: x\n\n')).toBe(false);
    expect(res.destroy).toHaveBeenCalledOnce();
  });
});

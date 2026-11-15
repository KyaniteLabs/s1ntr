import { afterEach, describe, expect, it } from 'vitest';
import { classifyProviderSurface, isOwnerLanGatewayUrl } from '../../../src/identity/executorAuthorityBootstrap.js';

// A documentation-range address (RFC 5737) stands in for an owner's LAN host.
const GATEWAY = '192.0.2.10:4000';

describe('owner LAN gateway is declared, not shipped', () => {
  const saved = process.env.SINTER_LAN_GATEWAY;
  afterEach(() => {
    if (saved === undefined) delete process.env.SINTER_LAN_GATEWAY;
    else process.env.SINTER_LAN_GATEWAY = saved;
  });

  it('recognises no gateway when SINTER_LAN_GATEWAY is unset', () => {
    delete process.env.SINTER_LAN_GATEWAY;
    expect(isOwnerLanGatewayUrl(`http://${GATEWAY}/v1`)).toBe(false);
    expect(classifyProviderSurface('openai', `http://${GATEWAY}/v1`, { model: 'lfm3' })).not.toBe('lan-gateway-litellm');
  });

  it('matches only the exact declared host and port', () => {
    process.env.SINTER_LAN_GATEWAY = GATEWAY;
    expect(isOwnerLanGatewayUrl(`http://${GATEWAY}/v1`)).toBe(true);
    expect(isOwnerLanGatewayUrl('http://192.0.2.10:4001/v1')).toBe(false);
    expect(isOwnerLanGatewayUrl('http://192.0.2.11:4000/v1')).toBe(false);
    expect(isOwnerLanGatewayUrl('not a url')).toBe(false);
  });

  it('gives free funding through the declared gateway only to free routes', () => {
    process.env.SINTER_LAN_GATEWAY = GATEWAY;
    expect(classifyProviderSurface('openai', `http://${GATEWAY}/v1`, { model: 'some-paid-model' })).toBe('unknown');
    expect(classifyProviderSurface('openai', `http://${GATEWAY}/v1`, { model: 'hy3' })).toBe('lan-gateway-litellm');
  });
});

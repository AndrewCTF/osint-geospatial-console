import { describe, it, expect } from 'vitest';
import { computeViewportScale } from './useViewportScale.js';

describe('computeViewportScale', () => {
  it('enlarges chrome at ~1080p logical width', () => {
    expect(computeViewportScale(1920).tier).toBe('1080');
    expect(computeViewportScale(1920).scale).toBeGreaterThan(1);
  });

  it('1440p keeps scale 1.0 (rails fixed → more map)', () => {
    const v = computeViewportScale(2560);
    expect(v.tier).toBe('1440');
    expect(v.scale).toBe(1.0);
  });

  it('4K enlarges chrome but rails stay a small fraction', () => {
    const v = computeViewportScale(3840);
    expect(v.tier).toBe('4k');
    expect(v.scale).toBeGreaterThan(1);
    expect(v.leftW + v.rightW).toBeLessThan(3840 * 0.25); // rails < 25% → map-dominant
  });

  it('rails never grow with the viewport (more map on bigger screens)', () => {
    // a 4K screen devotes a smaller FRACTION of width to rails than 1080p
    const small = computeViewportScale(1920);
    const big = computeViewportScale(3840);
    const fracSmall = (small.leftW + small.rightW) / 1920;
    const fracBig = (big.leftW + big.rightW) / 3840;
    expect(fracBig).toBeLessThan(fracSmall);
  });
});

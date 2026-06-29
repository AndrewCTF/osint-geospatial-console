// Responsive sizing for the Normal dashboard. The rails are FIXED-px, so a wider
// screen automatically yields MORE map (the chrome doesn't grow with the viewport).
// `scale` is a chrome-only readability multiplier (drives --ui-scale) for the two
// regimes where the dense UI otherwise reads too small: ~1080p logical width
// ("1080 blurry → enlarge a bit") and 4K (physical pixels are tiny). It is applied
// to the chrome font-size only — never to the globe canvas, which must stay crisp.
//
// Thresholds are deliberately simple and operator-tunable.
import { useEffect, useState } from 'react';

export type ScaleTier = 'compact' | '1080' | '1440' | '4k';

export interface ViewportScale {
  scale: number; // chrome readability multiplier → --ui-scale
  leftW: number; // default left rail width, px
  rightW: number; // default right rail width, px
  footerH: number; // timeline footer height, px
  tier: ScaleTier;
}

export function computeViewportScale(w: number): ViewportScale {
  if (w >= 3000) return { scale: 1.12, leftW: 324, rightW: 388, footerH: 176, tier: '4k' };
  if (w >= 2200) return { scale: 1.0, leftW: 300, rightW: 360, footerH: 160, tier: '1440' };
  if (w >= 1700) return { scale: 1.07, leftW: 300, rightW: 360, footerH: 160, tier: '1080' };
  return { scale: 1.0, leftW: 276, rightW: 332, footerH: 148, tier: 'compact' };
}

export function useViewportScale(): ViewportScale {
  const [vp, setVp] = useState<ViewportScale>(() =>
    computeViewportScale(typeof window !== 'undefined' ? window.innerWidth : 1920),
  );
  useEffect(() => {
    const onResize = (): void => setVp(computeViewportScale(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return vp;
}

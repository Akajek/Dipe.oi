// Pre-rendered sprite cache.
//
// Canvas gradients are expensive to build, and building one per bullet and per
// glow particle *per frame* is the single biggest cost in this renderer --
// especially on Linux, where Chrome often has no GPU acceleration for canvas
// and every gradient is rasterised in software. Bake them once into offscreen
// canvases instead and blit with drawImage.

const glowCache = new Map();
const ringCache = new Map();

/** Radial white-to-transparent glow tinted `color`, cached per colour. */
export function glowSprite(color, size = 64) {
  const key = color + '@' + size;
  let c = glowCache.get(key);
  if (c) return c;

  c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, color);
  grad.addColorStop(0.45, applyAlpha(color, 0.45));
  grad.addColorStop(1, applyAlpha(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);

  glowCache.set(key, c);
  return c;
}

/** Soft-edged filled disc, used for puffs. Cheaper than an arc + gradient. */
export function puffSprite(color, size = 48) {
  return glowSprite(color, size);
}

/**
 * A hollow ring with soft edges. `width` is the stroke thickness as a fraction
 * of the radius, so one sprite scales to any ring size.
 */
export function ringSprite(color, size = 96) {
  const key = color + '@' + size;
  let c = ringCache.get(key);
  if (c) return c;

  c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  g.strokeStyle = color;
  g.lineWidth = size * 0.09;
  g.beginPath();
  g.arc(r, r, r - g.lineWidth, 0, Math.PI * 2);
  g.stroke();

  ringCache.set(key, c);
  return c;
}

/**
 * Re-express a CSS colour at a given alpha. Handles the #rgb/#rrggbb and
 * rgb()/rgba() forms this project actually uses; anything else falls through
 * unchanged, which still renders, just without the fade.
 */
export function applyAlpha(color, alpha) {
  if (color[0] === '#') {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    const n = parseInt(hex, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map((s) => s.trim());
    return 'rgba(' + parts[0] + ',' + parts[1] + ',' + parts[2] + ',' + alpha + ')';
  }
  return color;
}

/** Drop every cached sprite. Called when the quality level changes. */
export function clearSprites() {
  glowCache.clear();
  ringCache.clear();
}

/**
 * Decide how to draw soft glows on THIS machine, by timing both options.
 *
 * The two paths win on different hardware and the gap is large either way:
 * with GPU-accelerated canvas a radial gradient fill is cheap and scaling a
 * sprite costs a resample, so gradients win. With software rendering (common
 * on Linux, and on any machine where the GPU is blocklisted) the gradient is
 * evaluated per pixel while the sprite is a straight blit, so sprites win.
 * Guessing wrong roughly triples the cost of every explosion, so measure.
 *
 * @returns {'sprite'|'gradient'}
 */
export function calibrateGlow() {
  try {
    const W = 480, H = 270, N = 60, ROUNDS = 8;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { alpha: false });
    if (!ctx) return 'gradient';

    const pts = [];
    for (let i = 0; i < N; i++) {
      pts.push({ x: Math.random() * W, y: Math.random() * H, r: 12 + Math.random() * 28 });
    }
    const color = '#00b2e1';

    const gradientPass = () => {
      for (const p of pts) {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        g.addColorStop(0, color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    const spritePass = () => {
      const img = glowSprite(color);
      for (const p of pts) ctx.drawImage(img, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
    };

    // Warm both paths first: JIT and the sprite bake must not be measured.
    gradientPass(); spritePass();

    const time = (fn) => {
      const t0 = performance.now();
      for (let i = 0; i < ROUNDS; i++) fn();
      return performance.now() - t0;
    };
    const gradMs = time(gradientPass);
    const spriteMs = time(spritePass);

    // Only switch away from gradients on a clear win, since the measurement is
    // noisy on a busy machine and gradients look marginally better.
    return spriteMs * 1.25 < gradMs ? 'sprite' : 'gradient';
  } catch {
    return 'gradient';
  }
}

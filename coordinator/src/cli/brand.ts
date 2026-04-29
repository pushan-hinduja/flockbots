/**
 * FlockBots brand primitives for the CLI.
 *
 * Colors, the pixel-art duck mascot, the FLOCKBOTS wordmark, the boot-line
 * formatter, and status words all live here. Every color call respects
 * NO_COLOR and falls back to plain text on non-TTY streams so the output
 * stays friendly to CI logs and pipes.
 *
 * Palette matches the brand kit hex values:
 *   duck    #F4D03A   shadow #D9A92A   bill    #F08A2A
 *   outline #2A1D08   console #0A0B0D  foreground #E8E6E0
 */

type RGB = readonly [number, number, number];

export const COLORS = {
  duck:    [0xf4, 0xd0, 0x3a] as RGB,
  shadow:  [0xd9, 0xa9, 0x2a] as RGB,
  bill:    [0xf0, 0x8a, 0x2a] as RGB,
  outline: [0x2a, 0x1d, 0x08] as RGB,
  console: [0x0a, 0x0b, 0x0d] as RGB,
  fg:      [0xe8, 0xe6, 0xe0] as RGB,
  dim:     [0x8a, 0x8a, 0x84] as RGB,
  // Helper text uses ANSI 8-color cyan (\x1b[36m) rather than a truecolor hex
  // so it matches clack's active-prompt marker on whatever terminal theme
  // the user has. See help() below.
};

// ---------------------------------------------------------------------------
// Terminal capability + color helpers
// ---------------------------------------------------------------------------

export function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === 'dumb') return false;
  return !!process.stdout.isTTY;
}

export function fg(color: RGB, text: string): string {
  if (!colorEnabled()) return text;
  return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m${text}\x1b[0m`;
}

export function bold(text: string): string {
  if (!colorEnabled()) return text;
  return `\x1b[1m${text}\x1b[22m`;
}

export function dim(text: string): string {
  return fg(COLORS.dim, text);
}

/**
 * Max width (in columns) for content inside p.note boxes. Matches the
 * longest line in the welcome box's time-estimate row so the boxes are
 * visually consistent across the wizard. Applied via help() so every call
 * site gets it for free.
 */
export const NOTE_MAX_WIDTH = 76;

/**
 * Word-wrap each input line to `maxWidth`. Preserves leading whitespace as
 * the continuation indent; for "- foo" / "* foo" / "1. foo" list items, the
 * continuation also pads past the marker so wrapped text aligns with the
 * first character of the bullet content. Words longer than `maxWidth` (long
 * URLs, file paths) are emitted on their own line rather than mid-broken.
 */
export function wrapText(text: string, maxWidth: number = NOTE_MAX_WIDTH): string {
  return text
    .split('\n')
    .map(line => wrapLine(line, maxWidth))
    .join('\n');
}

function wrapLine(line: string, maxWidth: number): string {
  if (line.length <= maxWidth) return line;

  const m = line.match(/^(\s*)(?:([-*•])\s+|(\d+\.)\s+)?(.*)$/);
  if (!m) return line;
  const indent = m[1];
  const marker = m[2] || m[3] || '';
  const body = m[4];

  const firstPrefix = marker ? `${indent}${marker} ` : indent;
  const contPrefix = marker ? indent + ' '.repeat(marker.length + 1) : indent;

  const words = body.split(/\s+/).filter(Boolean);
  if (words.length === 0) return line;

  const out: string[] = [];
  let cur = firstPrefix + words[0];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const candidate = cur + ' ' + w;
    if (candidate.length > maxWidth) {
      out.push(cur);
      cur = contPrefix + w;
    } else {
      cur = candidate;
    }
  }
  out.push(cur);
  return out.join('\n');
}

/**
 * Color helper text with ANSI 8-color cyan (SGR 36) so it's guaranteed to
 * match clack's active-prompt marker — clack uses picocolors' `.cyan` which
 * also emits SGR 36. That way whatever shade the user's terminal theme
 * renders cyan in (macOS Terminal, iTerm, VSCode integrated terminal, etc.),
 * the instructional text inside note boxes and the selected-state indicator
 * are the same hue.
 *
 * Also wraps content to NOTE_MAX_WIDTH so every p.note(help([...])) box has
 * the same visual width across the wizard.
 *
 * Applied per-line because clack's note renderer iterates line-by-line to
 * draw the box border, and a single escape at the top of a multi-line
 * string ends up scoped to the first line only.
 */
export function help(text: string): string {
  const wrapped = wrapText(text);
  if (!colorEnabled()) return wrapped;
  // \x1b[22m turns off dim/bold. clack's p.note wraps body lines in
  // e.dim(...) (\x1b[2m) which crushes our cyan into a washed-out tone
  // that reads lighter than clack's own ◆ active-prompt marker. Prepending
  // [22m cancels clack's dim before we apply [36m cyan, so the text
  // renders at the same brightness as the marker.
  const prefix = '\x1b[22m\x1b[36m';
  const suffix = '\x1b[0m';
  return wrapped
    .split('\n')
    .map(line => (line.length > 0 ? prefix + line + suffix : line))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Pixel duck mascot
// ---------------------------------------------------------------------------

/**
 * The duck sprite — verbatim ANSI from the brand kit export
 * (`duck.ansi.txt`). 20 cols × 21 pixel rows, rendered with 2 terminal
 * chars per pixel so each block reads as a square (terminal cells are
 * ~2:1 taller than wide). Each line is a pre-escaped 24-bit truecolor
 * sequence and is emitted straight to the terminal — no palette lookup,
 * no post-processing. Transparent pixels use `\x1b[49m` (default bg) so
 * the duck blends into whatever terminal theme the user runs.
 */
const DUCK_ANSI_LINES: readonly string[] = [
  '\x1b[49m            \x1b[48;2;42;29;8m            \x1b[49m                \x1b[0m',
  '\x1b[49m            \x1b[48;2;42;45;53m  \x1b[48;2;58;61;69m  \x1b[48;2;20;22;26m      \x1b[48;2;5;6;10m  \x1b[49m                \x1b[0m',
  '\x1b[49m            \x1b[48;2;42;45;53m  \x1b[48;2;20;22;26m        \x1b[48;2;5;6;10m  \x1b[49m                \x1b[0m',
  '\x1b[49m            \x1b[48;2;42;45;53m  \x1b[48;2;20;22;26m        \x1b[48;2;5;6;10m  \x1b[49m                \x1b[0m',
  '\x1b[49m            \x1b[48;2;217;168;32m  \x1b[48;2;244;192;58m    \x1b[48;2;255;229;116m  \x1b[48;2;244;192;58m  \x1b[48;2;176;138;24m  \x1b[49m                \x1b[0m',
  '\x1b[49m          \x1b[48;2;42;29;8m                \x1b[49m              \x1b[0m',
  '\x1b[49m          \x1b[48;2;42;29;8m  \x1b[48;2;244;208;58m          \x1b[48;2;42;29;8m  \x1b[49m                \x1b[0m',
  '\x1b[49m  \x1b[48;2;42;29;8m        \x1b[48;2;255;229;116m              \x1b[48;2;42;29;8m  \x1b[49m              \x1b[0m',
  '\x1b[48;2;42;29;8m  \x1b[48;2;255;167;80m        \x1b[48;2;244;208;58m        \x1b[48;2;20;22;26m    \x1b[48;2;244;208;58m  \x1b[48;2;42;29;8m  \x1b[49m              \x1b[0m',
  '\x1b[48;2;42;29;8m  \x1b[48;2;240;138;42m        \x1b[48;2;244;208;58m              \x1b[48;2;42;29;8m  \x1b[49m              \x1b[0m',
  '\x1b[48;2;42;29;8m  \x1b[48;2;196;106;24m        \x1b[48;2;217;169;42m              \x1b[48;2;42;29;8m  \x1b[49m              \x1b[0m',
  '\x1b[49m  \x1b[48;2;42;29;8m          \x1b[49m                  \x1b[48;2;42;29;8m      \x1b[49m    \x1b[0m',
  '\x1b[49m      \x1b[48;2;42;29;8m  \x1b[48;2;255;229;116m                      \x1b[49m  \x1b[48;2;255;229;116m    \x1b[48;2;42;29;8m  \x1b[49m  \x1b[0m',
  '\x1b[49m    \x1b[48;2;42;29;8m  \x1b[48;2;244;208;58m  \x1b[48;2;14;16;20m  \x1b[48;2;232;230;224m  \x1b[48;2;14;16;20m  \x1b[48;2;90;95;100m  \x1b[48;2;244;208;58m                      \x1b[48;2;42;29;8m  \x1b[0m',
  '\x1b[49m    \x1b[48;2;42;29;8m  \x1b[48;2;244;208;58m  \x1b[48;2;90;95;100m  \x1b[48;2;14;16;20m  \x1b[48;2;232;230;224m  \x1b[48;2;14;16;20m  \x1b[48;2;244;208;58m                      \x1b[48;2;42;29;8m  \x1b[0m',
  '\x1b[49m    \x1b[48;2;42;29;8m  \x1b[48;2;244;208;58m                                \x1b[48;2;42;29;8m  \x1b[0m',
  '\x1b[49m    \x1b[48;2;42;29;8m  \x1b[48;2;217;169;42m                                \x1b[48;2;42;29;8m  \x1b[0m',
  '\x1b[49m      \x1b[48;2;42;29;8m  \x1b[48;2;192;144;34m                            \x1b[48;2;42;29;8m  \x1b[49m  \x1b[0m',
  '\x1b[49m        \x1b[48;2;42;29;8m                            \x1b[49m    \x1b[0m',
  '\x1b[49m            \x1b[48;2;240;138;42m      \x1b[49m      \x1b[48;2;240;138;42m      \x1b[49m          \x1b[0m',
  '\x1b[49m            \x1b[48;2;196;106;24m      \x1b[49m      \x1b[48;2;196;106;24m      \x1b[49m          \x1b[0m',
];

/** ANSI sprite dimensions — 1 pixel = 2 terminal chars in `renderDuck()`. */
export const DUCK_ANSI_WIDTH = 20;
export const DUCK_ANSI_HEIGHT = 21;

/** SVG viewBox for the richer web duck (hat + wand + sparkles + chest badge). */
export const DUCK_SVG_VIEWBOX = '-2 -1 32 22';

/**
 * Inline SVG body for the web duck — the `duckInline` symbol body verbatim
 * from the brand kit (`FlockBots Branding.html`). 86 `<rect>` elements
 * plus 5 `<animate>` loops powering the blinking LED on the hat and the
 * chest-panel data readout + scanline.
 *
 * Coordinates are on a 32×22 grid (viewBox `-2 -1 32 22`) — the console
 * background (`#0a0b0d`) is transparent by default so the duck blends into
 * whatever surface it's rendered onto.
 *
 * Consumed by the CLI's branded HTML pages (wizard-github) and mirrored
 * verbatim in `dashboard/src/components/Logo.tsx` for the dashboard +
 * login surfaces. Keep the two copies in sync when the brand ships an
 * updated design.
 */
const DUCK_INLINE_SVG_BODY = `<rect x="7" y="-1" width="6" height="1" fill="#2a1d08"></rect> <rect x="7" y="0" width="6" height="1" fill="#14161a"></rect> <rect x="7" y="1" width="6" height="1" fill="#14161a"></rect> <rect x="7" y="2" width="6" height="1" fill="#14161a"></rect> <rect x="7" y="0" width="1" height="3" fill="#2a2d35"></rect> <rect x="12" y="0" width="1" height="3" fill="#05060a"></rect> <rect x="7" y="3" width="6" height="1" fill="#f4c03a"></rect> <rect x="7" y="3" width="1" height="1" fill="#d9a820"></rect> <rect x="12" y="3" width="1" height="1" fill="#b08a18"></rect> <rect x="9.6" y="3.2" width="0.8" height="0.6" fill="#ffe574"></rect> <rect x="6" y="4" width="8" height="1" fill="#2a1d08"></rect> <rect x="6" y="4" width="8" height="0.4" fill="#000000"></rect> <rect x="8" y="0" width="1" height="1" fill="#3a3d45" opacity="0.85"></rect> <rect x="5" y="10" width="2" height="1" fill="#2a1d08"></rect> <rect x="16" y="10" width="3" height="1" fill="#2a1d08"></rect> <rect x="4" y="11" width="1" height="1" fill="#2a1d08"></rect> <rect x="19" y="11" width="1" height="1" fill="#2a1d08"></rect> <rect x="3" y="12" width="1" height="1" fill="#2a1d08"></rect> <rect x="20" y="12" width="1" height="1" fill="#2a1d08"></rect> <rect x="3" y="13" width="1" height="2" fill="#2a1d08"></rect> <rect x="20" y="13" width="1" height="3" fill="#2a1d08"></rect> <rect x="3" y="15" width="1" height="1" fill="#2a1d08"></rect> <rect x="4" y="16" width="1" height="1" fill="#2a1d08"></rect> <rect x="19" y="16" width="1" height="1" fill="#2a1d08"></rect> <rect x="5" y="17" width="14" height="1" fill="#2a1d08"></rect> <rect x="5" y="11" width="11" height="1" fill="#ffe574"></rect> <rect x="4" y="12" width="16" height="1" fill="#f4d03a"></rect> <rect x="4" y="13" width="16" height="1" fill="#f4d03a"></rect> <rect x="4" y="14" width="16" height="1" fill="#f4d03a"></rect> <rect x="4" y="15" width="16" height="1" fill="#d9a92a"></rect> <rect x="5" y="16" width="14" height="1" fill="#c09022"></rect> <rect x="16" y="10" width="1" height="0" fill="#ffe574"></rect> <rect x="17" y="11" width="2" height="1" fill="#ffe574"></rect> <rect x="19" y="11" width="0" height="0" fill="#2a1d08"></rect> <rect x="18" y="10" width="1" height="1" fill="#2a1d08"></rect> <rect x="7" y="4" width="5" height="1" fill="#2a1d08"></rect> <rect x="6" y="5" width="1" height="1" fill="#2a1d08"></rect> <rect x="12" y="5" width="1" height="1" fill="#2a1d08"></rect> <rect x="5" y="6" width="1" height="1" fill="#2a1d08"></rect> <rect x="13" y="6" width="1" height="1" fill="#2a1d08"></rect> <rect x="5" y="7" width="1" height="1" fill="#2a1d08"></rect> <rect x="13" y="7" width="1" height="3" fill="#2a1d08"></rect> <rect x="5" y="8" width="1" height="2" fill="#2a1d08"></rect> <rect x="7" y="5" width="5" height="1" fill="#ffe574"></rect> <rect x="6" y="6" width="7" height="1" fill="#f4d03a"></rect> <rect x="6" y="7" width="7" height="1" fill="#f4d03a"></rect> <rect x="6" y="8" width="7" height="1" fill="#f4d03a"></rect> <rect x="6" y="9" width="7" height="1" fill="#d9a92a"></rect> <rect x="9" y="6" width="1" height="2" fill="#2a1d08"></rect> <rect x="9" y="6" width="1" height="1" fill="#e8e6e0" opacity="0.85"></rect> <rect x="11" y="5" width="1" height="1" fill="#e8e6e0"> <animate attributeName="opacity" values="1;0.3;1" dur="1.6s" repeatCount="indefinite"></animate> </rect> <rect x="11" y="8" width="1" height="1" fill="#ff9fb0" opacity="0.85"></rect> <rect x="2" y="6" width="1" height="1" fill="#2a1d08"></rect> <rect x="3" y="6" width="3" height="1" fill="#f08a2a"></rect> <rect x="2" y="7" width="4" height="1" fill="#c46a18"></rect> <rect x="1" y="7" width="1" height="1" fill="#2a1d08"></rect> <rect x="3" y="6" width="1" height="1" fill="#ffc56a"></rect> <rect x="2" y="8" width="1" height="1" fill="#2a1d08"></rect> <rect x="3" y="8" width="3" height="1" fill="#f08a2a"></rect> <rect x="2" y="9" width="4" height="1" fill="#2a1d08"></rect> <rect x="10" y="13" width="6" height="1" fill="#d9a92a"></rect> <rect x="10" y="14" width="1" height="1" fill="#2a1d08"></rect> <rect x="16" y="14" width="1" height="1" fill="#2a1d08"></rect> <rect x="11" y="14" width="5" height="1" fill="#d9a92a"></rect> <rect x="11" y="15" width="5" height="1" fill="#2a1d08"></rect> <rect x="12" y="13" width="1" height="1" fill="#c09022" opacity="0.8"></rect> <rect x="14" y="13" width="1" height="1" fill="#c09022" opacity="0.8"></rect> <rect x="19" y="11" width="1" height="1" fill="#2a1d08"></rect> <rect x="18" y="12" width="1" height="1" fill="#2a1d08"></rect> <rect x="6" y="12" width="4" height="2" fill="#0a0b0d"></rect> <rect x="6" y="12" width="4" height="1" fill="#14161a"></rect> <rect x="6.5" y="12.3" width="0.7" height="0.7" fill="#f4c03a"> <animate attributeName="opacity" values="1;0.2;1" dur="1.4s" repeatCount="indefinite"></animate> </rect> <rect x="7.7" y="12.3" width="0.7" height="0.7" fill="#e8e6e0"> <animate attributeName="opacity" values="0.2;1;0.2" dur="1.4s" repeatCount="indefinite"></animate> </rect> <rect x="8.9" y="12.3" width="0.7" height="0.7" fill="#f4c03a" opacity="0.5"> <animate attributeName="opacity" values="0.3;0.9;0.3" dur="1.9s" repeatCount="indefinite"></animate> </rect> <rect x="6.3" y="13.2" width="0.5" height="0.5" fill="#e8e6e0" opacity="0.9"></rect> <rect x="7.0" y="13.4" width="0.5" height="0.3" fill="#e8e6e0" opacity="0.7"></rect> <rect x="7.7" y="13.1" width="0.5" height="0.6" fill="#e8e6e0" opacity="0.9"></rect> <rect x="8.4" y="13.3" width="0.5" height="0.4" fill="#e8e6e0" opacity="0.7"></rect> <rect x="9.1" y="13.1" width="0.5" height="0.6" fill="#e8e6e0" opacity="0.9"></rect> <rect x="6" y="12.7" width="4" height="0.1" fill="#e8e6e0" opacity="0.25"> <animate attributeName="y" values="12.1;13.8;12.1" dur="2.6s" repeatCount="indefinite"></animate> </rect> <rect x="7" y="18" width="3" height="1" fill="#f08a2a"></rect> <rect x="14" y="18" width="3" height="1" fill="#f08a2a"></rect> <rect x="7" y="19" width="3" height="1" fill="#c46a18"></rect> <rect x="14" y="19" width="3" height="1" fill="#c46a18"></rect> <rect x="7" y="18" width="1" height="1" fill="#ffc56a" opacity="0.7"></rect> <rect x="14" y="18" width="1" height="1" fill="#ffc56a" opacity="0.7"></rect>`;

/**
 * Render the duck as terminal lines. Returns an empty array when color is
 * disabled (NO_COLOR, TERM=dumb, non-TTY) — the pixel sprite is
 * color-dependent, so in those contexts the banner falls back to just the
 * wordmark + tagline.
 */
export function renderDuck(): string[] {
  if (!colorEnabled()) return [];
  return DUCK_ANSI_LINES.slice();
}

/**
 * Render the web duck as a standalone SVG string. `pixelSize` scales each
 * sprite unit (viewBox is 32×22) to that many rendered pixels — default 3
 * gives 96×66, matching the previous sprite's on-page footprint.
 */
export function renderDuckSvg(opts?: { pixelSize?: number }): string {
  const size = opts?.pixelSize ?? 3;
  const w = 32 * size;
  const h = 22 * size;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${DUCK_SVG_VIEWBOX}" shape-rendering="crispEdges" aria-label="FlockBots">${DUCK_INLINE_SVG_BODY}</svg>`;
}

/** Inner SVG body (no `<svg>` wrapper) — for consumers that roll their own `<svg>`. */
export function duckInlineSvgBody(): string {
  return DUCK_INLINE_SVG_BODY;
}

// ---------------------------------------------------------------------------
// Wordmark + tagline
// ---------------------------------------------------------------------------

const WORDMARK: readonly string[] = [
  '███████╗██╗      ██████╗  ██████╗██╗  ██╗██████╗  ██████╗ ████████╗███████╗',
  '██╔════╝██║     ██╔═══██╗██╔════╝██║ ██╔╝██╔══██╗██╔═══██╗╚══██╔══╝██╔════╝',
  '█████╗  ██║     ██║   ██║██║     █████╔╝ ██████╔╝██║   ██║   ██║   ███████╗',
  '██╔══╝  ██║     ██║   ██║██║     ██╔═██╗ ██╔══██╗██║   ██║   ██║   ╚════██║',
  '██║     ███████╗╚██████╔╝╚██████╗██║  ██╗██████╔╝╚██████╔╝   ██║   ███████║',
  '╚═╝     ╚══════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝╚═════╝  ╚═════╝    ╚═╝   ╚══════╝',
];

const WORDMARK_COMPACT = ['F L O C K B O T S'];

export const TAGLINE = 'a flock of ai agents · idea → deploy';

export function renderWordmark(): string[] {
  const term = process.stdout.columns || 80;
  const lines = term >= WORDMARK[0].length ? WORDMARK : WORDMARK_COMPACT;
  return lines.map(l => fg(COLORS.duck, l));
}

/**
 * Full banner — duck stacked above the wordmark, with the tagline below.
 * Stacked rather than side-by-side so it fits any 72+ col terminal; the
 * wordmark alone is 72 chars wide, no way to tuck a duck beside it cleanly.
 */
export function renderBanner(): string {
  const duck = renderDuck();
  const mark = renderWordmark();
  const tagline = dim(TAGLINE);

  const parts: string[] = [''];
  if (duck.length > 0) {
    const duckPad = 17; // center the 40-col-wide duck (20 pixels × 2 chars) over the 75-col wordmark
    parts.push(...duck.map(l => ' '.repeat(duckPad) + l), '');
  }
  parts.push(...mark, '', '  ' + tagline, '');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Boot-sequence line formatter
// ---------------------------------------------------------------------------

export type BootStatus = 'OK' | 'READY' | 'DONE' | 'SKIP' | 'FLAG' | 'IDLE' | 'FAIL';

const STATUS_COLORS: Record<BootStatus, RGB> = {
  OK:    COLORS.duck,
  READY: COLORS.duck,
  DONE:  COLORS.duck,
  SKIP:  COLORS.dim,
  FLAG:  COLORS.bill,
  IDLE:  COLORS.dim,
  FAIL:  COLORS.bill,
};

const LEADER_TARGET = 54; // right-align status words roughly at col 54

/**
 * Format a branded boot/progress line.
 *
 *   • label · detail ................................. STATUS
 *
 * Bullet is duck-yellow, label is bright foreground, detail (optional) is
 * dim, leader dots fill to the target column, and the status word is
 * colored by its kind.
 */
export function progressLine(label: string, detail: string | null, status: BootStatus): string {
  const bullet = fg(COLORS.duck, '•');
  const labelStr = label;
  const detailStr = detail ? ' ' + fg(COLORS.dim, '·') + ' ' + dim(detail) : '';
  // Compute visible length (no ANSI) for leader padding
  const visibleLen = 2 /* bullet + space */ + labelStr.length + (detail ? 3 + detail.length : 0);
  const dots = Math.max(3, LEADER_TARGET - visibleLen);
  const leader = fg(COLORS.dim, ' ' + '.'.repeat(dots) + ' ');
  const statusStr = fg(STATUS_COLORS[status], status);
  return `${bullet} ${labelStr}${detailStr}${leader}${statusStr}`;
}

export function promptLine(message: string): string {
  const duck = '🦆';
  const arrow = fg(COLORS.duck, '>');
  return `${duck} ${arrow} ${message}`;
}

export function header(prompt: string): string {
  const user = fg(COLORS.duck, 'flockbots');
  const path = fg(COLORS.fg, '~/console');
  const dollar = fg(COLORS.duck, '$');
  return `${user} ${path} ${dollar} ${prompt}`;
}

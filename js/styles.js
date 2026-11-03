// The display styles (plan feature 7): which passes each draws, its
// background, and the edge colours the paper styles use by state. Pure data
// and small functions, no DOM: the renderers read a style's flags from the
// frame, main.js the choice and the default.
//
//   Shaded          faces
//   Shaded + edges  faces; boundary edges (the face colour darkened)
//   Hidden line     faces depth-only; cut fill; visible edges, on paper
//   Hidden grey     as Hidden line, plus the hidden edges dashed and lighter
//   Wire            edges at every depth, no faces, on paper
//   X-ray           faces at alpha faceAlpha (0.25) without depth write; edges (lightened)
//
// Paper styles draw on #f4f4f2; outline styles also draw the silhouette
// candidates (the outlines of curved faces), since shading cannot show them.
// seesHidden: edges behind faces are drawn, so Measure may snap to them.
// faceAlpha: the faces' alpha where they are blended ('xray'): both renderers read it from the frame.
//
// A new style is one row here plus its case in edgePasses(); main.js lists
// every row in the Style select and both renderers draw whatever passes the
// frame carries.

export const STYLES = [
  { id: 'shaded', label: 'Shaded', faces: 'shade', edges: false, outline: false, paper: false, seesHidden: false },
  { id: 'edges', label: 'Shaded + edges', faces: 'shade', edges: true, outline: false, paper: false, seesHidden: false },
  { id: 'hidden', label: 'Hidden line', faces: 'depth', edges: true, outline: true, paper: true, seesHidden: false },
  { id: 'hiddengrey', label: 'Hidden grey', faces: 'depth', edges: true, outline: true, paper: true, seesHidden: true },
  { id: 'wire', label: 'Wire', faces: 'none', edges: true, outline: true, paper: true, seesHidden: true },
  { id: 'xray', label: 'X-ray', faces: 'xray', faceAlpha: 0.25, edges: true, outline: true, paper: false, seesHidden: true },
];

export const styleById = (id) => STYLES.find((s) => s.id === id) || null;
// every style id, for the readers that check one (a tour step, a model list entry, a view link)
export const STYLE_IDS = STYLES.map((s) => s.id);

// Until a choice is made: Shaded, for every file. (A b-rep file started in
// Shaded + edges; its outlines, drawn over every part once the edge list was
// built, made a board look worse, operator 2026-10-29.) E or the Style
// select turns them on. The argument stays for callers that pass the type.
export const defaultStyle = (_isMeshFile) => 'shaded';

// The style in force: an explicit, known choice, else the per-type default.
export const styleFor = (choice, isMeshFile) => (styleById(choice) ? choice : defaultStyle(isMeshFile));

// E: Shaded <-> Shaded + edges. In any other style it changes nothing, and
// the caller says so on #hover.
export const toggleEdges = (id) => ({ shaded: 'edges', edges: 'shaded' }[id] || null);

export const PAPER = '#f4f4f2';
// the dark view's background (the shaded styles, the dark ground)
export const VIEW_BG = '#1d2127';
export const CUT_FILL = '#b8b8b2';

// Paper edge colours by state: [visible, hidden]. Each state keeps hidden
// lighter than visible, so the depth cue never flips; the selected hue is the
// selection's own cyan darkened.
export const PAPER_EDGES = {
  plain: ['#1a1a1a', '#8a8a86'],
  selected: ['#085a72', '#4f8fa3'],
  faded: ['#a8a8a4', '#bebeba'],
};

// '#rrggbb' -> [r, g, b] in 0..1 (the colour picker's too: js/palettes.js hexToRgb)
export const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const hex = rgb;

// A style's edge passes, in draw order: each a depth test ('lequal' |
// 'greater' | 'always'), a colour mode (0 the face colour darkened, 1 the
// paper colours by state, 2 the face colour lightened), a dash period in
// device px, the paper colours ([r, g, b] by state), and selectedOnly. null:
// the style draws no edges. scale: device px per CSS px. onLight: drawn on a
// light ground, where X-ray's lightened edges would all but vanish, so they
// take the paper colours.
const DASH_PX = 6; // the hidden edges: 3 px drawn, 3 px gap
const paperColours = (k) => ({ plain: rgb(PAPER_EDGES.plain[k]), selected: rgb(PAPER_EDGES.selected[k]), faded: rgb(PAPER_EDGES.faded[k]) });
export function edgePasses(id, { scale = 1, onLight = false } = {}) {
  const visible = { depth: 'lequal', mode: 1, colours: paperColours(0) };
  switch (id) {
    case 'edges': return [{ depth: 'lequal', mode: 0 }];
    case 'hidden': return [visible];
    // the hidden edges first, so a visible edge wins where they cross; only
    // the selected or hovered parts' (every part's is a grey thicket on a
    // dense model), so with nothing selected it reads as Hidden line
    case 'hiddengrey': return [{ depth: 'greater', mode: 1, dash: DASH_PX * scale, colours: paperColours(1), selectedOnly: true }, visible];
    case 'wire': return [{ ...visible, depth: 'always' }];
    case 'xray': return [onLight ? { ...visible, depth: 'always' } : { depth: 'always', mode: 2 }];
    default: return null;
  }
}

// WCAG contrast ratio of two #rrggbb colours
export function contrast(a, b) {
  const lum = (h) => {
    const [r, g, bl] = hex(h).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

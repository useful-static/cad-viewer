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
//   X-ray           faces at alpha 0.25 without depth write; edges (lightened)
//
// Paper styles draw on #f4f4f2; outline styles also draw the silhouette
// candidates (the outlines of curved faces), since shading cannot show them.

export const STYLES = [
  { id: 'shaded', label: 'Shaded', faces: 'shade', edges: false, outline: false, paper: false, hidden: false },
  { id: 'edges', label: 'Shaded + edges', faces: 'shade', edges: true, outline: false, paper: false, hidden: false },
  { id: 'hidden', label: 'Hidden line', faces: 'depth', edges: true, outline: true, paper: true, hidden: false },
  { id: 'hiddengrey', label: 'Hidden grey', faces: 'depth', edges: true, outline: true, paper: true, hidden: true },
  { id: 'wire', label: 'Wire', faces: 'none', edges: true, outline: true, paper: true, hidden: false },
  { id: 'xray', label: 'X-ray', faces: 'xray', edges: true, outline: true, paper: false, hidden: false },
];

export const styleById = (id) => STYLES.find((s) => s.id === id) || null;

// Until a choice is made: Shaded + edges for a b-rep file (its edges are the
// CAD program's), Shaded for a mesh file (its triangle edges are not).
export const defaultStyle = (isMeshFile) => (isMeshFile ? 'shaded' : 'edges');

// The style in force: an explicit, known choice, else the per-type default.
export const styleFor = (choice, isMeshFile) => (styleById(choice) ? choice : defaultStyle(isMeshFile));

// E: Shaded <-> Shaded + edges. In any other style it changes nothing, and
// the caller says so on #hover.
export const toggleEdges = (id) => ({ shaded: 'edges', edges: 'shaded' }[id] || null);

export const PAPER = '#f4f4f2';
export const CUT_FILL = '#b8b8b2';

// Paper edge colours by state: [visible, hidden]. Each state keeps hidden
// lighter than visible, so the depth cue never flips; the selected hue is the
// selection's own cyan darkened.
export const PAPER_EDGES = {
  plain: ['#1a1a1a', '#8a8a86'],
  selected: ['#085a72', '#4f8fa3'],
  faded: ['#a8a8a4', '#bebeba'],
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
export const rgb = (h) => hex(h);

// WCAG contrast ratio of two #rrggbb colours
export function contrast(a, b) {
  const lum = (h) => {
    const [r, g, bl] = hex(h).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

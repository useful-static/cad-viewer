// The viewer's colours are sRGB bytes; glTF's are linear (COLOR_0, baseColorFactor, and an
// averaged texture's light). The one conversion each way, for the glTF reader (js/mesh-formats.js)
// and the GLB writer (js/export-mesh.js): a GLB written in sRGB came back lighter -- drawn
// rgb(128,64,200), read rgb(188,137,229) -- r70 Q1.

// an sRGB byte's linear light, 0..1
export const SRGB_TO_LINEAR = Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
// linear light, 0..1 per channel, to sRGB 0..1 (the first three)
export const linearToSrgb = (f) => f.slice(0, 3).map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));

# alayra-nexus brand assets

The three-tier logo system. Cyan is the product signature; bronze is inherited
from the Alayra Systems parent mark. Source of truth is SVG — PNGs are exports.

## Tiers

| Tier | Use it for | Files |
|------|-----------|-------|
| **Crest** (ceremonial) | Hero banners, splash, merch, "about" pages | `svg/alayra-nexus-crest.svg`, `png/alayra-nexus-crest-{1024,512}.png` |
| **Crest lockup** | Crest + wordmark, marketing headers | `svg/alayra-nexus-crest-lockup.svg`, `png/alayra-nexus-crest-lockup-{1600,800}.png` |
| **Logo** (working) | Site header, docs, README | `svg/alayra-nexus-logo.svg`, `png/alayra-nexus-logo-{512,256}.png` |
| **Glyph** (reduced) | Favicon, GitHub avatar, npm/PyPI | `svg/alayra-nexus-glyph.svg`, `png/alayra-nexus-glyph-{512,256,128,64,32,16}.png` |
| **Glyph mono** | Monochrome / recolorable contexts | `svg/alayra-nexus-glyph-mono.svg`, `png/alayra-nexus-glyph-mono-{512,256,128}.png` |

The mono glyph uses `currentColor`, so it inherits the surrounding text color when
inlined in HTML. The PNG exports are rendered in cyan (`#22d3ee`).

## Palette

| Role | Hex |
|------|-----|
| Cyan core | `#5df0ee` |
| Cyan primary | `#22d3ee` |
| Cyan deep | `#3ce8e5` |
| Bronze light | `#e6c98f` |
| Bronze | `#b8863f` |
| Bronze accent | `#d9b477` |
| Disc background | `#0b1622` |

## Regenerating PNGs

PNGs are rendered from the SVGs with [`@resvg/resvg-js`](https://github.com/yisibl/resvg-js).
Edit the SVG, then re-run the render step (Node 18+):

```
npm install @resvg/resvg-js
node render.js   # renders every SVG to png/ at the sizes above
```

See `TRADEMARK.md` in the repo root: Apache-2.0 covers the code, not these marks.

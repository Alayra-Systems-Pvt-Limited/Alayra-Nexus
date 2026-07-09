// Renders every brand SVG to PNG at preset sizes.
//   npm install @resvg/resvg-js
//   node render.js
const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

const SVG_DIR = path.join(__dirname, 'svg');
const PNG_DIR = path.join(__dirname, 'png');
fs.mkdirSync(PNG_DIR, { recursive: true });

// [sourceSvg, outputBasename, colorReplace|null, [sizes...]]
const jobs = [
  ['alayra-nexus-crest.svg',        'alayra-nexus-crest',        null,      [1024, 512]],
  ['alayra-nexus-crest-lockup.svg', 'alayra-nexus-crest-lockup', null,      [1600, 800]],
  ['alayra-nexus-logo.svg',         'alayra-nexus-logo',         null,      [512, 256]],
  ['alayra-nexus-glyph.svg',        'alayra-nexus-glyph',        null,      [512, 256, 128, 64, 32, 16]],
  ['alayra-nexus-glyph-mono.svg',   'alayra-nexus-glyph-mono',   '#22d3ee', [512, 256, 128]],
];

for (const [src, base, color, sizes] of jobs) {
  let svg = fs.readFileSync(path.join(SVG_DIR, src), 'utf8');
  if (color) svg = svg.split('currentColor').join(color);
  for (const w of sizes) {
    const r = new Resvg(svg, { fitTo: { mode: 'width', value: w }, font: { loadSystemFonts: true } });
    fs.writeFileSync(path.join(PNG_DIR, `${base}-${w}.png`), r.render().asPng());
  }
}
console.log('Rendered all PNGs to', PNG_DIR);

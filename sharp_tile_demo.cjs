const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const OUT = '/home/ubuntu/sharp_tile_demo';
fs.mkdirSync(OUT, { recursive: true });

// ─── Create a synthetic motif: a colourful circle on white background ─────────
// This simulates what Picsart removebg would produce from an AI-generated image
// (subject on transparent/white background)

async function createSyntheticMotif(size = 400) {
  // A bold circular badge design on white
  const svg = `
<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="white"/>
  <!-- Outer ring -->
  <circle cx="${size/2}" cy="${size/2}" r="${size*0.42}" fill="#1a1a2e" stroke="none"/>
  <!-- Inner coloured circle -->
  <circle cx="${size/2}" cy="${size/2}" r="${size*0.35}" fill="#e94560"/>
  <!-- Paw print body -->
  <circle cx="${size/2}" cy="${size*0.56}" r="${size*0.16}" fill="#ffd700"/>
  <!-- Paw toes -->
  <circle cx="${size*0.38}" cy="${size*0.38}" r="${size*0.07}" fill="#ffd700"/>
  <circle cx="${size*0.5}" cy="${size*0.33}" r="${size*0.07}" fill="#ffd700"/>
  <circle cx="${size*0.62}" cy="${size*0.38}" r="${size*0.07}" fill="#ffd700"/>
  <!-- Highlight -->
  <circle cx="${size*0.42}" cy="${size*0.44}" r="${size*0.04}" fill="rgba(255,255,255,0.4)"/>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ─── Tile function ─────────────────────────────────────────────────────────────
// Tiles a motif (with transparent background) onto a coloured canvas
// canvasW x canvasH: output dimensions
// tileW x tileH: size of each tile (controls scale/density)
// bgColour: background fill
// offsetX, offsetY: for brick/hex offset patterns
async function tileMotif({ motifBuffer, canvasW, canvasH, tileW, tileH, bgColour = '#ffffff', pattern = 'grid', padding = 0 }) {
  // Create background canvas
  const background = sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: bgColour,
    }
  }).png();

  // Resize motif to tile size (minus padding)
  const motifSize = Math.max(10, tileW - padding * 2);
  const resizedMotif = await sharp(motifBuffer)
    .resize(motifSize, motifSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Build composite array
  const composites = [];
  const cols = Math.ceil(canvasW / tileW) + 1;
  const rows = Math.ceil(canvasH / tileH) + 1;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let x = col * tileW + padding;
      let y = row * tileH + padding;

      // Brick offset: every other row shifts by half a tile width
      if (pattern === 'brick' && row % 2 === 1) {
        x += tileW / 2;
      }
      // Diamond offset: every other row shifts by half
      if (pattern === 'diamond' && row % 2 === 1) {
        x += tileW / 2;
      }

      composites.push({
        input: resizedMotif,
        left: Math.round(x),
        top: Math.round(y),
        blend: 'over',
      });
    }
  }

  const bgBuffer = await background.toBuffer();
  const result = await sharp(bgBuffer)
    .composite(composites)
    .png()
    .toBuffer();

  return result;
}

async function main() {
  console.log('Creating synthetic motif...');
  const motifBuffer = await createSyntheticMotif(400);
  fs.writeFileSync(path.join(OUT, '0_motif_original.png'), motifBuffer);
  console.log('Motif saved.');

  // Simulate Picsart removebg result: remove white, make transparent
  // (In production, Picsart does this. Here we just use the SVG which has white bg)
  // For demo, we'll show tiling WITH white bg (as-is from AI) and also show
  // what it looks like on coloured backgrounds

  const canvasW = 2400;
  const canvasH = 3200; // Leggings-style tall format

  const demos = [
    // Grid, white bg, medium tiles
    { name: '1_grid_white_medium', pattern: 'grid', tileW: 400, tileH: 400, bgColour: '#ffffff', padding: 20 },
    // Grid, black bg, medium tiles
    { name: '2_grid_black_medium', pattern: 'grid', tileW: 400, tileH: 400, bgColour: '#000000', padding: 20 },
    // Grid, navy bg, small tiles (more repeats)
    { name: '3_grid_navy_small', pattern: 'grid', tileW: 280, tileH: 280, bgColour: '#1a1a4e', padding: 15 },
    // Brick offset, white bg
    { name: '4_brick_white_medium', pattern: 'brick', tileW: 400, tileH: 400, bgColour: '#ffffff', padding: 20 },
    // Brick offset, dark bg, small
    { name: '5_brick_dark_small', pattern: 'brick', tileW: 300, tileH: 300, bgColour: '#2d1b4e', padding: 15 },
    // Diamond offset, cream bg
    { name: '6_diamond_cream_medium', pattern: 'diamond', tileW: 380, tileH: 380, bgColour: '#fdf6e3', padding: 20 },
  ];

  for (const demo of demos) {
    console.log(`Generating: ${demo.name}...`);
    const result = await tileMotif({
      motifBuffer,
      canvasW,
      canvasH,
      tileW: demo.tileW,
      tileH: demo.tileH,
      bgColour: demo.bgColour,
      pattern: demo.pattern,
      padding: demo.padding,
    });
    // Save a scaled-down preview (800px wide) for easy viewing
    await sharp(result)
      .resize(800, null)
      .jpeg({ quality: 90 })
      .toFile(path.join(OUT, `${demo.name}.jpg`));
    console.log(`  Saved ${demo.name}.jpg`);
  }

  console.log('\nAll demos saved to', OUT);
}

main().catch(console.error);

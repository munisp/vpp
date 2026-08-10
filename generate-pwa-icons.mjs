import sharp from 'sharp';
import { promises as fs } from 'fs';

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
const baseIcon = './client/public/icons/icon-512x512.png';
const outputDir = './client/public/icons';

async function generateIcons() {
  console.log('Generating PWA icons...');
  
  for (const size of sizes) {
    const outputPath = `${outputDir}/icon-${size}x${size}.png`;
    await sharp(baseIcon)
      .resize(size, size, {
        fit: 'contain',
        background: { r: 16, g: 185, b: 129, alpha: 1 }
      })
      .png()
      .toFile(outputPath);
    console.log(`✓ Generated ${size}x${size}`);
  }
  
  console.log('All PWA icons generated successfully!');
}

generateIcons().catch(console.error);

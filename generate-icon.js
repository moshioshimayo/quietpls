const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

// Create a 512x512 canvas
const canvas = createCanvas(512, 512);
const ctx = canvas.getContext('2d');

// Create gradient background circle
const gradient = ctx.createLinearGradient(0, 0, 512, 512);
gradient.addColorStop(0, '#10b981');
gradient.addColorStop(1, '#059669');

// Draw circle background
ctx.fillStyle = gradient;
ctx.beginPath();
ctx.arc(256, 256, 240, 0, Math.PI * 2);
ctx.fill();

// Draw microphone icon in white
ctx.fillStyle = 'white';

// Microphone body (rounded rectangle)
ctx.beginPath();
ctx.moveTo(256 - 40, 120 + 20);
ctx.arcTo(256 - 40, 120, 256 - 20, 120, 20);
ctx.arcTo(256 + 40, 120, 256 + 40, 120 + 20, 20);
ctx.lineTo(256 + 40, 260 - 20);
ctx.arcTo(256 + 40, 260, 256 + 20, 260, 20);
ctx.arcTo(256 - 40, 260, 256 - 40, 260 - 20, 20);
ctx.closePath();
ctx.fill();

// Microphone stand
ctx.beginPath();
ctx.moveTo(240, 280);
ctx.quadraticCurveTo(240, 340, 200, 360);
ctx.lineTo(200, 370);
ctx.lineTo(312, 370);
ctx.lineTo(312, 360);
ctx.quadraticCurveTo(272, 340, 272, 280);
ctx.closePath();
ctx.stroke();
ctx.lineWidth = 8;
ctx.strokeStyle = 'white';

// Sound waves (arcs on sides)
ctx.strokeStyle = 'white';
ctx.lineWidth = 8;
ctx.lineCap = 'round';

// Left sound wave
ctx.beginPath();
ctx.arc(256, 190, 100, -2.5, -0.64, false);
ctx.stroke();

// Right sound wave  
ctx.beginPath();
ctx.arc(256, 190, 100, -0.5, 1.36, false);
ctx.stroke();

// Larger sound waves
ctx.lineWidth = 6;
ctx.globalAlpha = 0.6;

// Left larger wave
ctx.beginPath();
ctx.arc(256, 190, 130, -2.6, -0.54, false);
ctx.stroke();

// Right larger wave
ctx.beginPath();
ctx.arc(256, 190, 130, -0.6, 1.46, false);
ctx.stroke();

// Save as PNG
const buffer = canvas.toBuffer('image/png');
const iconPath = path.join(__dirname, 'assets', 'icon.png');
fs.writeFileSync(iconPath, buffer);

console.log('✅ Icon generated successfully at:', iconPath);
console.log('   Size: 512x512 pixels');
console.log('   Ready for DMG build!');

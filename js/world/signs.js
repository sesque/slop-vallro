import * as THREE from 'three/webgpu';
import { cityUniforms } from '../tsl-materials.js';
import { CELL_H, CELL_W, atlasSize, buildSignGeometry } from './sign-geometry.js';

// js/world/signs.js
// The fascia signs of the town's shops (data/shops.json, tools/vallromanes/build-shops.mjs): one mesh, one draw call. The text is drawn into a
// canvas atlas in the browser; the sign glows a little at night, like the shop windows do (cityUniforms.uInteriorGlow).

// background and text colour by kind of business
export const SECTOR_STYLE = {
  food: ['#2e6b3f', '#ffffff'], pharmacy: ['#17824a', '#ffffff'], bar: ['#7c2230', '#fff4e0'], restaurant: ['#5b1f2a', '#fff4e0'],
  hotel: ['#1f3556', '#f3ead2'], bank: ['#0a4da2', '#ffffff'], shop: ['#303942', '#ffffff'], service: ['#33505c', '#ffffff']
};

function drawAtlas(shops, columns) {
  const { width, height } = atlasSize(shops.length, columns);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const g = canvas.getContext('2d');
  shops.forEach((s, k) => {
    const x = (k % columns) * CELL_W, y = Math.floor(k / columns) * CELL_H;
    const [bg, fg] = SECTOR_STYLE[s.sector] || SECTOR_STYLE.shop;
    g.fillStyle = bg;
    g.fillRect(x, y, CELL_W, CELL_H);
    // a thin light frame 6 px in, as shop signs have
    g.strokeStyle = fg;
    g.globalAlpha = 0.55;
    g.lineWidth = 2;
    g.strokeRect(x + 7, y + 7, CELL_W - 14, CELL_H - 14);
    g.globalAlpha = 1;
    // the name, as large as fits (the sign's proportions are those of the cell: 8 : 1, the text may squeeze)
    let size = 42;
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (; size > 18; size -= 2) {
      g.font = `700 ${size}px "Helvetica Neue", Arial, sans-serif`;
      if (g.measureText(s.name).width < CELL_W - 44) break;
    }
    g.fillText(s.name, x + CELL_W / 2, y + CELL_H / 2 + 2);
  });
  return canvas;
}

export function buildSigns(scene, shops, columns = 4) {
  const group = new THREE.Group();
  group.name = 'Signs';
  if (!shops.length) return { group, update() {}, stats: { signs: 0 } };
  const data = buildSignGeometry(shops, columns);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
  geometry.computeBoundingSphere();
  const texture = new THREE.CanvasTexture(drawAtlas(shops, columns));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new THREE.MeshStandardNodeMaterial({ map: texture, roughness: 0.6, metalness: 0 });
  material.emissiveMap = texture;
  material.emissive = new THREE.Color(0xffffff);
  material.emissiveIntensity = 0;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'shop signs';
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  group.add(mesh);
  scene.add(group);
  // lit from within once it is dusk
  const update = () => {
    const glow = cityUniforms.uInteriorGlow.value;
    const t = Math.min(1, Math.max(0, (glow - 0.5) / 0.7));
    material.emissiveIntensity = t * t * (3 - 2 * t) * 0.75;
  };
  return { group, mesh, update, stats: { signs: shops.length } };
}

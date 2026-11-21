// Renders every Aurora app icon (PWA and Android launcher) from public/icons/aurora.svg.
// Full-bleed variants drop the rounded tile and shrink the #art group into the platform's safe zone.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const iconDirectory = resolve(scriptDirectory, "../public/icons");
const androidResources = resolve(scriptDirectory, "../../android/app/src/main/res");
const source = readFileSync(resolve(iconDirectory, "aurora.svg"), "utf8");

function variant({ fullBleed = false, artScale = 1, sky = true, art = true }) {
  let svg = source;
  if (fullBleed) svg = svg.replace('<rect width="512" height="512" rx="112"/>', '<rect width="512" height="512"/>');
  if (artScale !== 1)
    svg = svg.replace('<g id="art">', `<g id="art" transform="translate(256 256) scale(${artScale}) translate(-256 -256)">`);
  if (!sky) svg = svg.replace(/<rect id="backdrop"[^>]*\/>/, "");
  if (!art) svg = svg.replace(/<g id="art">[\s\S]*<\/g>\s*<\/g>\s*<\/svg>/, "</g></svg>");
  return svg;
}

function render(svg, size, path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng());
}

// PWA: the rounded tile for regular icons; maskable keeps the art inside the 80% safe circle.
render(variant({}), 192, resolve(iconDirectory, "aurora-192.png"));
render(variant({}), 512, resolve(iconDirectory, "aurora-512.png"));
render(variant({ fullBleed: true, artScale: 0.78 }), 512, resolve(iconDirectory, "aurora-maskable-512.png"));
render(variant({ fullBleed: true }), 180, resolve(iconDirectory, "apple-touch-icon.png")); // iOS rounds it itself

// Android adaptive launcher icon: 108dp layers at xxxhdpi, art within the 72dp visible area.
const drawable = resolve(androidResources, "drawable-xxxhdpi");
render(variant({ fullBleed: true, art: false }), 432, resolve(drawable, "ic_launcher_background.png"));
render(variant({ fullBleed: true, sky: false, artScale: 0.66 }), 432, resolve(drawable, "ic_launcher_foreground.png"));

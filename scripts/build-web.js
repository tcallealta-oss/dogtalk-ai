/* Arma la carpeta www/ que Capacitor empaqueta dentro de la APK.
   Solo copia lo que la app necesita: nada de node_modules, .git ni android/. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'www');

const FILES = [
  'index.html', 'app.js', 'styles.css', 'sw.js', 'manifest.json',
  'icon-192.png', 'icon-512.png', 'icon-maskable.png', 'apple-touch-icon.png',
];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

let n = 0;
for (const f of FILES) {
  const src = path.join(root, f);
  if (!fs.existsSync(src)) { console.warn('· falta (se omite):', f); continue; }
  fs.copyFileSync(src, path.join(out, f));
  n++;
}
console.log(`www/ listo — ${n} archivos copiados`);

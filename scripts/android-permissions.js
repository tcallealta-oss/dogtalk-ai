/* Inyecta en el AndroidManifest los permisos que la app usa desde la WebView:
   micrófono (detección de ladridos), cámara (análisis de postura) y notificaciones.
   Sin esto la APK compila igual, pero getUserMedia falla en el teléfono. */
const fs = require('fs');
const path = require('path');

const manifest = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (!fs.existsSync(manifest)) {
  console.error('No existe el AndroidManifest — ¿corriste "npx cap add android"?');
  process.exit(1);
}

const PERMS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.CAMERA',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.VIBRATE',
  // alarmas exactas: sin esto Android puede correr media hora la toma del remedio
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.USE_EXACT_ALARM',
  'android.permission.RECEIVE_BOOT_COMPLETED',
];

let xml = fs.readFileSync(manifest, 'utf8');
const faltantes = PERMS.filter(p => !xml.includes(`"${p}"`));

if (faltantes.length) {
  const bloque = faltantes.map(p => `    <uses-permission android:name="${p}" />`).join('\n');
  xml = xml.replace('</manifest>', `${bloque}\n\n    <uses-feature android:name="android.hardware.camera" android:required="false" />\n    <uses-feature android:name="android.hardware.microphone" android:required="false" />\n</manifest>`);
  fs.writeFileSync(manifest, xml);
}

console.log(faltantes.length ? `Permisos agregados: ${faltantes.join(', ')}` : 'Los permisos ya estaban declarados');

# 📱 Cómo obtener la app en tu teléfono — DogTalk AI

Tres rutas, de la más rápida a la más completa.

---

## ✅ Ruta 1 — Instalarla YA como PWA (0 minutos, sin compilar)

La app ya es una **PWA instalable**. En Android queda con su icono en el escritorio, a pantalla
completa y sin barra del navegador — se ve y se usa igual que una app nativa.

1. Publica la carpeta en cualquier hosting con HTTPS (obligatorio para PWA):
   - **Netlify Drop**: arrastra la carpeta a https://app.netlify.com/drop → te da una URL al instante
   - **Vercel**: `npx vercel --prod` dentro de la carpeta
   - **GitHub Pages**: sube la carpeta a un repo y activa Pages
2. Abre esa URL en **Chrome del teléfono**
3. Menú ⋮ → **"Instalar aplicación"** (o aparece solo el botón 📲 Instalar app)

**Ventaja:** funciona hoy, se actualiza sola al publicar cambios, no necesita Play Store.
**Limitación:** el micrófono solo escucha con la app abierta (no en segundo plano).

---

## 📦 Ruta 2 — APK sin instalar nada (PWABuilder, ~10 min)

Microsoft ofrece un servicio gratuito que convierte una PWA en APK firmada.

1. Publica la app con HTTPS (paso 1 de la Ruta 1)
2. Entra a **https://www.pwabuilder.com**
3. Pega tu URL → *Start* → pestaña **Android** → **Generate Package**
4. Descargas un `.zip` con:
   - `app-release-signed.apk` ← **esta es tu APK**, instalable directo
   - `.aab` para subir a Google Play
   - La clave de firma (guárdala, la necesitas para futuras actualizaciones)

**Es la ruta más rápida para tener un archivo APK real en la mano.**

---

## 🛠️ Ruta 3 — Compilar localmente con Capacitor (control total)

Necesario si más adelante quieres **escucha en segundo plano**, notificaciones push nativas
o publicar en Play Store con funciones nativas.

### Requisitos (instalar una vez, ~8 GB)
- **Android Studio**: https://developer.android.com/studio (incluye SDK y Gradle)
- **JDK 17**: viene con Android Studio

### Comandos (dentro de esta carpeta)
```bash
npm install
npx cap init "DogTalk AI" cl.dogtalk.app --web-dir=.
npx cap add android
npx cap sync android
```

Generar la APK de prueba:
```bash
cd android && gradlew.bat assembleDebug
```
→ queda en `android/app/build/outputs/apk/debug/app-debug.apk`

O abrir en Android Studio para firmar la versión de producción:
```bash
npx cap open android
```
→ *Build → Generate Signed Bundle / APK*

### Permisos que debes agregar en `android/app/src/main/AndroidManifest.xml`
```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

---

## 🎯 Recomendación

Para **probarla en tu teléfono hoy** → Ruta 1.
Para **tener el archivo .apk y compartirlo** → Ruta 2.
Para **publicar en Play Store con funciones nativas** → Ruta 3.

> Nota: la compilación de la APK no se puede hacer en este equipo porque no tiene
> Android SDK ni Java instalados. Las rutas 1 y 2 no los necesitan.

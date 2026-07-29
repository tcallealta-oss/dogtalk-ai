# 📱 Cómo obtener la app en tu teléfono — DogTalk AI

## ✅ Ruta 1 — Descargar la APK ya compilada (recomendada)

La APK se compila **sola en la nube** (GitHub Actions) cada vez que se genera una versión.
No necesitas Android Studio, Java ni SDK en el notebook.

**Descarga directa desde el teléfono:**
👉 https://github.com/tcallealta-oss/dogtalk-ai/releases/latest

1. Abre ese link en el navegador del celular
2. Descarga `DogTalk-AI.apk`
3. Ábrela → Android pide permitir *"instalar apps de esta fuente"* → aceptar
4. Al primer uso concede **micrófono** y **cámara**

### Generar una versión nueva (después de cambiar el código)

```bash
git push
gh workflow run apk.yml --ref main
```

Tarda ~2 minutos. Para ver el avance y la nueva URL:

```bash
gh run watch --exit-status && gh release view --web
```

### Qué hace el workflow (`.github/workflows/apk.yml`)

| Paso | Qué resuelve |
|---|---|
| `scripts/build-web.js` | Copia a `www/` solo los archivos de la app (sin `node_modules`, `.git` ni `android/`) |
| `npx cap add android` | Genera el proyecto Android desde cero en el runner |
| `scripts/android-permissions.js` | Inyecta `RECORD_AUDIO`, `CAMERA`, `POST_NOTIFICATIONS`, `MODIFY_AUDIO_SETTINGS` y `VIBRATE` en el AndroidManifest — sin esto `getUserMedia` falla dentro de la WebView |
| `gradlew assembleDebug` | Compila la APK firmada con la clave de debug (instalable en cualquier teléfono) |
| `gh release create` | La publica como descarga pública |

---

## 📲 Ruta 2 — Instalarla como PWA (sin APK)

La app también es una PWA instalable, servida en
**https://tcallealta-oss.github.io/dogtalk-ai/**

Chrome del teléfono → menú ⋮ → **Instalar aplicación**.
Queda con icono propio y a pantalla completa, y **se actualiza sola** con cada `git push`.

Diferencia con la APK: la PWA no puede pedir permisos nativos persistentes ni,
más adelante, escuchar en segundo plano.

---

## 🏪 Ruta 3 — Publicar en Google Play

Para la tienda hace falta un **AAB firmado con clave propia** (no la de debug):

1. Generar el keystore una vez:
   ```bash
   keytool -genkey -v -keystore dogtalk.jks -keyalg RSA -keysize 2048 -validity 10000 -alias dogtalk
   ```
2. Cargarlo como secreto del repositorio (`KEYSTORE_BASE64`, `KEYSTORE_PASS`, `KEY_ALIAS`)
3. Cambiar en el workflow `assembleDebug` por `bundleRelease` y firmar con esos secretos
4. Subir el `.aab` a Play Console (cuenta de desarrollador: USD 25, pago único)

> La compilación local con Android Studio sigue siendo posible (`npm install`,
> `npm run build:web`, `npx cap add android`, `npx cap open android`), pero pide
> ~8 GB de herramientas en el notebook. La ruta 1 evita todo eso.

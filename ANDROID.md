# NavMate for Android

The website (`navmate.stationinsight.com`) installs to a phone's home screen,
but a browser pauses it whenever the screen locks — the track, position
sharing with command and turn-by-turn steering all stop. The Android app is the
same code in a native shell (Capacitor) with one difference that matters:
**GPS keeps running with the screen off**, shown by a "NavMate is tracking your
position" notification while tracking is on.

It is installed straight from an APK file. Google Play is not involved.

## Getting the APK

GitHub builds it on every push (`.github/workflows/android.yml`):

- **Push to `main`** → a new **Release** named "NavMate for Android 1.0.N" with
  `NavMate-1.0.N.apk` attached (repo → Releases → Latest).
- **Any session branch** → the APK is attached to the workflow run under
  **Artifacts** (repo → Actions → Android APK → the run), for testing.

## Installing on a phone

1. Get the `.apk` onto the phone (download it, or send it by text, email or
   Drive).
2. Tap it. The first time, Android asks to allow your browser/Files app to
   **install unknown apps** — allow it, go back, tap Install.
3. Open NavMate and sign in. When tracking starts, allow location access and
   notifications.

**Updates** install over the old copy and keep everything saved on the phone,
because every build is signed with the same key.

## The signing key

Android only installs an update over an existing app when both were signed
with the same key. The key is **never kept in this repository**; the workflow
reads it from four repository secrets (Settings → Secrets and variables →
Actions → New repository secret):

| Secret | Value |
|---|---|
| `NAVMATE_KEYSTORE_BASE64` | the `.jks` key file, base64-encoded |
| `NAVMATE_KEYSTORE_PASSWORD` | its store password |
| `NAVMATE_KEY_ALIAS` | `navmate` |
| `NAVMATE_KEY_PASSWORD` | its key password |

Without them every build is signed with a throwaway key: the APK still
installs, but each new one needs the old app uninstalled first (losing what
is saved on that phone). The workflow prints a warning when that happens.

Keep a copy of the key file somewhere safe. Losing it means every phone has to
uninstall and reinstall once.

## How the app differs from the website

`src/lib/native.ts` holds every difference:

- **Background GPS**: `useTracker.start()` uses the
  `@capacitor-community/background-geolocation` foreground service instead of
  `navigator.geolocation.watchPosition`; positions go through the same filter.
  `android.useLegacyBridge` is on, or updates stop after 5 minutes.
- **Its address**: the app runs at `https://localhost`, so links that leave
  the phone (email sign-up/reset, team invites) and the `/api/enc` chart relay
  use the live site (`VITE_PUBLIC_ORIGIN`). `api/enc.js` allows
  `https://localhost` to read its responses.
- **No service worker**: the app carries its own files.

## Building locally

Needs Android Studio (or the Android SDK) and JDK 21.

    npm run android:sync          # build the web app and copy it in
    cd android && ./gradlew assembleRelease

Icons and the launch screen are generated from `brand/emblem.png` by
`scripts/make-icons.mjs` (runs on every `npm run build`).

import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The Android app: the same build as the website (`dist/`), wrapped in a
 * native shell so GPS keeps running with the screen off. Installed straight
 * from an APK, not through Google Play — see ANDROID.md.
 */
const config: CapacitorConfig = {
  appId: 'com.stationinsight.navmate',
  appName: 'NavMate',
  webDir: 'dist',
  android: {
    // Without this, location updates stop after five minutes in the
    // background (capacitor-community/background-geolocation#89).
    useLegacyBridge: true,
  },
  server: {
    androidScheme: 'https',
  },
  backgroundColor: '#06131f',
}

export default config

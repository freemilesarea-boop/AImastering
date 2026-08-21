import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.louver.mastering.mobile',
  appName: 'Loui Mastering',
  webDir: 'dist',
  // Android-only test app. iOS not configured (out of scope).
  plugins: {
    // Route fetch/XHR through the native HTTP layer. CapacitorHttp is built
    // into @capacitor/core (NOT a new plugin); enabling it makes cross-origin
    // calls to the mastering API bypass the WebView's CORS/"Failed to fetch"
    // restriction (WebView origin https://localhost -> https://<render>).
    CapacitorHttp: { enabled: true },
  },
};

export default config;

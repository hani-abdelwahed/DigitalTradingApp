import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

const api = process.env.API_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  // Use @dta/shared's TypeScript sources directly.
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: {
    port: 5173,
    // Proxy API paths so the refresh cookie stays same-origin in development.
    proxy: {
      '/auth': api,
      '/health': api,
      '/market': api,
      '/portfolio': api,
      '/orders': api,
      '/fills': api,
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
});

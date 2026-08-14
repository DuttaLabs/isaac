import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // The @isaac/* packages are TypeScript source linked through the workspace.
    // Excluding them from dependency pre-bundling lets Vite transform them like
    // app source, so engine edits hot-reload here instead of needing a rebuild.
    exclude: ['@isaac/optical-core', '@isaac/zemax-io', '@isaac/glass-catalog'],
  },
  server: { port: 5173 },
});

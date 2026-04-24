import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `office-test.html` is a dev-only harness for iterating on the office
// visualization without auth. It's served in `vite` but intentionally not
// included in `vite build` output.
export default defineConfig({
  plugins: [react()],
  server: { port: 3000 },
});

// Library/SSR build of the graph-build CLI for Node 24: `npm run build-graph -- <args>`.
// Bundles src/routing/* plus the pure deps (fflate, pbf) into one file; node builtins stay external.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root,
  publicDir: false,
  logLevel: 'warn',
  build: {
    ssr: 'tools/build-graph/cli.ts',
    outDir: 'tools/build-graph/dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    rollupOptions: { output: { entryFileNames: 'cli.js', format: 'es' } },
  },
  ssr: { target: 'node', noExternal: ['fflate', 'pbf'] },
});

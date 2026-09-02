// Library/SSR build of the graph-build CLIs for Node 24: `npm run build-graph -- <args>` (cli.js)
// and `node tools/build-graph/dist/continent.js <cmd>` (build-continent.ts, coverage v2).
// Bundles src/routing/* plus the pure deps (fflate, pbf) per entry; node builtins stay external.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root,
  publicDir: false,
  logLevel: 'warn',
  build: {
    ssr: true,
    outDir: 'tools/build-graph/dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: { cli: 'tools/build-graph/cli.ts', continent: 'tools/build-graph/build-continent.ts' },
      output: { entryFileNames: '[name].js', format: 'es' },
    },
  },
  ssr: { target: 'node', noExternal: ['fflate', 'pbf'] },
});

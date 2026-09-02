/**
 * Dev-server config for the Playwright runs (playwright.config.ts → webServer): the app config
 * with HMR and the file watcher off. Vite full-reloads the page on any src/ edit (the app has no
 * HMR accept handlers), which restarts the app in the middle of a test whenever someone edits a
 * file while the suite runs. Modules are still transformed on demand, so the server serves the
 * code as it was when each module was first requested.
 */
import { mergeConfig } from 'vite';
import base from '../../vite.config';

export default mergeConfig(base, {
  clearScreen: false,
  server: { hmr: false, watch: null },
});

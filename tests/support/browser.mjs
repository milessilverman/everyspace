// Set E2E_BROWSER to chromium, webkit, or firefox before running npm run e2e.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return require('playwright'); } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    const globalModules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return createRequire(path.join(globalModules, 'package.json'))('playwright');
  }
}

export const browserName = process.env.E2E_BROWSER || 'chromium';
if (!['chromium', 'webkit', 'firefox'].includes(browserName)) {
  throw new Error(`Unknown E2E_BROWSER "${browserName}". Use chromium, webkit, or firefox.`);
}

export const launchBrowser = () => loadPlaywright()[browserName].launch();

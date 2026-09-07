import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

mkdirSync('dist', { recursive: true });
// xterm's stylesheet → dist for index.html to link
copyFileSync('node_modules/@xterm/xterm/css/xterm.css', 'dist/xterm.css');

const common = { bundle: true, sourcemap: true, logLevel: 'info' };

// Electron main + preload: real Node processes.
await esbuild.build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron', 'node-pty'] });
await esbuild.build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] });

// Private overlay: compile private/index.ts into the bundle when present, else the stub.
const privateEntry = existsSync('private/index.ts') ? path.resolve('private/index.ts') : path.resolve('src/private-stub.ts');

// Renderer runs with nodeIntegration, so Node built-ins, electron, and node-pty are
// resolved at runtime via require() — keep them external; bundle xterm + our code.
// format MUST be 'iife' (not 'cjs'): loaded via a classic <script>, a cjs bundle leaves
// module-level declarations (e.g. `const top` in ready-queue) in the GLOBAL scope, where
// they collide with read-only window properties (window.top) and throw. iife wraps the
// whole bundle in a function so nothing leaks to global; require() is still global.
await esbuild.build({ ...common, entryPoints: ['src/app.ts'], outfile: 'dist/renderer.js', platform: 'node', format: 'iife', external: ['electron', 'node-pty'], alias: { 'wcc-private': privateEntry } });

// Browser mirror bundle (spec 2026-09-07): a plain-browser build of src/web. platform 'browser'
// makes any accidental Node import (fs, path, child_process, electron) a hard build error.
mkdirSync('dist/web', { recursive: true });
await esbuild.build({ ...common, entryPoints: ['src/web/main.ts'], outfile: 'dist/web/app.js', platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
copyFileSync('web/index.html', 'dist/web/index.html');
copyFileSync('web/web.css', 'dist/web/web.css');
copyFileSync('app.css', 'dist/web/app.css');
copyFileSync('styles.css', 'dist/web/styles.css');
copyFileSync('node_modules/@xterm/xterm/css/xterm.css', 'dist/web/xterm.css');

console.log('esbuild: built main, preload, renderer, web');

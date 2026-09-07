// src/web/main.ts  (placeholder — Task 14 replaces it)
import { createBridge } from './bridge';
const bridge = createBridge({ url: location.origin.replace(/^http/, 'ws') + '/ws' });
bridge.onStatus((s) => { document.getElementById('app')!.textContent = `bridge: ${s}`; });

import { installDomShim } from '../ui/dom-shim';
import { createBridge } from './bridge';
import { mountLogin } from './login';
import { mountFloor } from './floor';

installDomShim();
const root = document.getElementById('app')!;
const bridge = createBridge({ url: location.origin.replace(/^http/, 'ws') + '/ws' });

let unmount: (() => void) | null = null;
function showLogin(): void { unmount?.(); unmount = mountLogin(root, bridge, showFloor); }
function showFloor(): void { unmount?.(); unmount = mountFloor(root, bridge); }

bridge.onStatus((s) => { if (s === 'login' && !root.querySelector('.web-login')) showLogin(); });
if (bridge.status() === 'open') showFloor(); else showLogin();

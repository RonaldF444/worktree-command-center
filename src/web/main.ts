import { installDomShim } from '../ui/dom-shim';
import { installWindowDragGuard } from '../ui/modifier-drag';
import { createBridge } from './bridge';
import { mountLogin } from './login';
import { mountFloor } from './floor';

installDomShim();
installWindowDragGuard(); // Win+drag = window-manager move on a Windows client, never a selection
const root = document.getElementById('app')!;
const bridge = createBridge({ url: location.origin.replace(/^http/, 'ws') + '/ws' });

let unmount: (() => void) | null = null;
function showLogin(): void { unmount?.(); unmount = mountLogin(root, bridge, showFloor); }
function showFloor(): void { unmount?.(); unmount = mountFloor(root, bridge); }

bridge.onStatus((s) => { if (s === 'login' && !root.querySelector('.web-login')) showLogin(); });
if (bridge.status() === 'open') showFloor(); else showLogin();

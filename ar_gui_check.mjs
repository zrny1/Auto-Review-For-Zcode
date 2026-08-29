import { GUI_PS_SCRIPT } from './src/gui.js';
import fs from 'node:fs';
fs.writeFileSync('D:/Demo/DemoSuperVisionForZcode/ar_gui_check.ps1', '\uFEFF' + GUI_PS_SCRIPT, 'utf8');
console.log('exported');

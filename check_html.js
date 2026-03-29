const fs = require('fs');
const path = require('path');

const mediaPath = 'media';
const html = fs.readFileSync(path.join(mediaPath, 'speechEngine.html'), 'utf8');
const style = fs.readFileSync(path.join(mediaPath, 'style.css'), 'utf8');
const script = fs.readFileSync(path.join(mediaPath, 'dashboard.js'), 'utf8');

const hasStyleSlot = html.includes('${inlineStyle}');
const hasScriptSlot = html.includes('${inlineScript}');
const hasCspSlot = html.includes('${cspSource}');

console.log('Template slots found:');
console.log('  ${inlineStyle}:', hasStyleSlot);
console.log('  ${inlineScript}:', hasScriptSlot);
console.log('  ${cspSource}:', hasCspSlot);
console.log('  style.css size:', style.length, 'chars');
console.log('  dashboard.js size:', script.length, 'chars');
console.log('  speechEngine.html size:', html.length, 'chars');

const clientConfig = 'window.__BOOTSTRAP_CONFIG__ = { native: true, extensionVersion: "1.1.0" };';
let result = html.replace('<head>', '<head><!-- CSP -->');
result = result.replace(/\$\{inlineStyle\}/g, style);
result = result.replace(/\$\{inlineScript\}/g, clientConfig + '\n' + script);
result = result.replace(/\$\{cspSource\}/g, 'vscode-webview://test');

console.log('  Final generated size:', result.length, 'chars');
console.log('  Style injected (radial-gradient):', result.includes('radial-gradient'));
console.log('  Script injected (READALOUD):', result.includes('READALOUD'));
console.log('  Bootstrap config injected:', result.includes('__BOOTSTRAP_CONFIG__'));

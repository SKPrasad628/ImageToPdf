// Check the static application's resource references without fetching anything.
// Dynamic PDF.js asset collections are checked by the pinned vendor inventory.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const origin = 'https://page-forge.invalid/';

function checkApplicationAssets(directory = path.resolve(__dirname, '..')) {
  const root = path.resolve(directory);
  const visited = new Set();

  function reference(resource, from) {
    resource = resource.trim();
    if (!resource || /^(?:data:|blob:|#)/i.test(resource)) return;
    const base = new URL(from.split(path.sep).join('/'), origin);
    const target = new URL(resource, base);
    if (target.origin !== new URL(origin).origin || target.protocol !== 'https:') {
      throw new Error(`External application resource in ${from}: ${resource}`);
    }
    const filename = path.resolve(root, '.' + decodeURIComponent(target.pathname));
    const relative = path.relative(root, filename);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error(`Application resource leaves the app folder: ${resource}`);
    }
    if (!fs.existsSync(filename)) throw new Error(`Missing application resource in ${from}: ${resource}`);
    const stat = fs.statSync(filename);
    if (!stat.isDirectory()) inspect(relative);
  }

  function styles(source, from) {
    // Comments are not requests; @import can contain a plain string or url().
    source = source.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, resource] of source.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)) reference(resource, from);
    for (const [, resource] of source.matchAll(/@import\s+["']([^"']+)["']/gi)) reference(resource, from);
  }

  function inspect(relative) {
    if (visited.has(relative)) return;
    visited.add(relative);
    const extension = path.extname(relative).toLowerCase();
    if (!['.html', '.css', '.js', '.mjs'].includes(extension)) return;
    // Pinned bundles can contain optional network APIs. The app configures their
    // worker/asset URLs locally, and their bytes are verified separately.
    if (relative.startsWith('vendor' + path.sep)) return;
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    if (extension === '.css') { styles(source, relative); return; }
    if (extension === '.html') {
      if (/<base\b/i.test(source)) throw new Error('A base element can redirect local application resources.');
      const resources = /<(?:script|link|img|iframe|source|video|audio|embed|object)\b[^>]*?(?:src|href|data)=["']([^"']*)["'][^>]*>/gi;
      for (const [, resource] of source.matchAll(resources)) reference(resource, relative);
      for (const [, css] of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) styles(css, relative);
      for (const [, css] of source.matchAll(/\bstyle=["']([^"']*)["']/gi)) styles(css, relative);
      return;
    }
    // Literal lazy module/worker paths used by the current application. Variable
    // URL policy is exercised by the PDF loader and preservation runtime tests.
    const patterns = [
      /new\s+URL\(\s*["']([^"']+)["']/g,
      /(?:import|importScripts|fetch)\(\s*["']([^"']+)["']/g,
      /new\s+Worker\(\s*["']([^"']+)["']/g
    ];
    for (const pattern of patterns) {
      for (const [, resource] of source.matchAll(pattern)) reference(resource, relative);
    }
  }

  inspect('index.html');
  return { count: visited.size, files: [...visited].sort().map(file => file.split(path.sep).join('/')) };
}

if (require.main === module) {
  try {
    const result = checkApplicationAssets();
    process.stdout.write(`Verified ${result.count} local application resource files.\n`);
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
module.exports = { checkApplicationAssets };

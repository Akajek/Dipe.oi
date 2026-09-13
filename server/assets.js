// Versioned static assets.
//
// The client is plain ES modules with no bundler, so every file is fetched by
// its own URL and cached independently. With a plain max-age that means a
// redeploy leaves each visitor with their own mixture of old and new files --
// one person's main.js from today next to their builder.js from last week.
// The result is a page that renders controls whose handlers do not exist, and
// it differs per person, which makes it look like nothing in particular.
//
// Fix: stamp a build id into every module URL. index.html is always
// revalidated and points at the current stamp, so one cheap request pulls in a
// wholly consistent set. Because a stamped URL can only ever mean one build,
// those responses are then safe to cache forever.

import fs from 'node:fs';
import path from 'node:path';

// Matches the relative specifier in `from './x.js'` and `import('./x.js')`.
const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+?\.js)\2/g;

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

export class AssetServer {
  /**
   * @param {string} root    project root
   * @param {string} buildId short fingerprint of this deploy
   */
  constructor(root, buildId) {
    this.root = root;
    this.buildId = buildId;
    this.cache = new Map();   // url path -> { body, type }
    this.load();
  }

  /** Read and rewrite every module once, at boot. */
  load() {
    const dirs = [
      { url: '/js/', dir: path.join(this.root, 'client', 'js') },
      { url: '/shared/', dir: path.join(this.root, 'shared') },
    ];
    for (const { url, dir } of dirs) {
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        this.cache.set(url + f, { body: this.stamp(src), type: MIME['.js'] });
      }
    }

    // Stylesheets get the same treatment: they are stamped in the HTML, so
    // they may as well be cached immutably rather than revalidated.
    const cssDir = path.join(this.root, 'client', 'css');
    try {
      for (const f of fs.readdirSync(cssDir)) {
        if (!f.endsWith('.css')) continue;
        this.cache.set('/css/' + f, {
          body: fs.readFileSync(path.join(cssDir, f), 'utf8'),
          type: MIME['.css'],
        });
      }
    } catch { /* no stylesheets is fine */ }

    // The entry point must reference the stamped module URL.
    const htmlPath = path.join(this.root, 'client', 'index.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf8')
        .replace(/(<script[^>]+src=")([^"]+\.js)(")/g, (_m, a, src, b) => a + src + '?v=' + this.buildId + b)
        .replace(/(<link[^>]+href=")(css\/[^"]+\.css)(")/g, (_m, a, href, b) => a + href + '?v=' + this.buildId + b);
      this.cache.set('/index.html', { body: html, type: MIME['.html'] });
    } catch { /* fall through to express.static */ }
  }

  /** Append the build stamp to every relative import inside a module. */
  stamp(src) {
    return src.replace(IMPORT_RE, (_m, kw, q, spec) => kw + q + spec + '?v=' + this.buildId + q);
  }

  /**
   * Express middleware. Serves rewritten modules; anything else falls through
   * to the normal static handler.
   */
  middleware() {
    return (req, res, next) => {
      const urlPath = req.path === '/' ? '/index.html' : req.path;
      const hit = this.cache.get(urlPath);
      if (!hit) return next();

      res.type(hit.type);
      if (urlPath === '/index.html') {
        // Cheap to revalidate, and it is what points at the current build.
        res.set('Cache-Control', 'no-cache');
      } else if (req.query.v === this.buildId) {
        // A stamped URL can only ever mean this build, so cache it hard.
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        // Unstamped (or stale stamp): never let it be reused.
        res.set('Cache-Control', 'no-store');
      }
      res.send(hit.body);
    };
  }
}

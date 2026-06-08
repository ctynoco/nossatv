const fs = require('fs');
const path = require('path');

const src = __dirname;
const dist = path.join(__dirname, 'public');

if (!fs.existsSync(dist)) fs.mkdirSync(dist, { recursive: true });

const files = [
  { name: 'index.html', minify: 'html' },
  { name: 'styles.css', minify: 'css' },
  { name: 'script.js', minify: 'module' },
  { name: 'source-types.js', minify: 'module' },
  { name: 'vereador-manager.js', minify: 'module' },
  { name: 'qrcode.js', minify: 'module' },
  { name: 'guest.html', minify: 'html' },
  { name: 'manifest.json' },
  { name: 'favicon.svg' },
  { name: 'service-worker.js' },
];

async function build() {
  for (const f of files) {
    const content = fs.readFileSync(path.join(src, f.name), 'utf-8');
    let out = content;

    if (f.minify === 'html') {
      const { minify } = require('html-minifier-terser');
      out = await minify(content, {
        collapseWhitespace: true,
        removeComments: true,
        removeAttributeQuotes: true,
        minifyCSS: true,
        minifyJS: true,
      });
    } else if (f.minify === 'css') {
      const postcss = require('postcss');
      const cssnano = require('cssnano');
      const result = await postcss([cssnano]).process(content, { from: f.name });
      out = result.css;
    } else if (f.minify === 'module') {
      // ES modules: remove comments and collapse whitespace only
      // (UglifyJS does not support import/export)
      out = content
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*[\r\n]/gm, '')
        .trim();
    }

    fs.writeFileSync(path.join(dist, f.name), out, 'utf-8');
    console.log(`✓ ${f.name} (${content.length} → ${out.length} bytes)`);
  }
  console.log('\nBuild concluído!');
}

build().catch((err) => { console.error(err); process.exit(1); });

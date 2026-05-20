const esbuild = require('esbuild');
const fs = require('fs');

async function build() {
  try {
    await Promise.all([
      esbuild.build({
        entryPoints: ['src/background/service-worker.ts'],
        bundle: true,
        outfile: 'dist/background/service-worker.js',
        platform: 'browser',
        target: 'chrome96',
        format: 'esm'
      }),
      esbuild.build({
        entryPoints: ['src/content/content-script.ts'],
        bundle: true,
        outfile: 'dist/content/content-script.js',
        platform: 'browser',
        target: 'chrome96'
      }),
      esbuild.build({
        entryPoints: ['src/popup/popup.ts'],
        bundle: true,
        outfile: 'dist/popup/popup.js',
        platform: 'browser',
        target: 'chrome96'
      })
    ]);

    // Copy static files only if all builds succeeded
    fs.cpSync('public', 'dist', { recursive: true });
    console.log('Extension build complete');
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}

build();

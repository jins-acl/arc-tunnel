const esbuild = require('esbuild');

const entries = [
  ['src/index.ts', 'dist/mcp-server.js'],
  ['src/broker-entry.ts', 'dist/arc-tunnel-broker.js'],
  ['src/broker-control.ts', 'dist/arc-tunnel-control.js']
];

Promise.all(entries.map(([entryPoint, outfile]) => esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile,
  sourcemap: true
}))).catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});

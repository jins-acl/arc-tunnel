const esbuild = require('esbuild');
const { publishDashboard } = require('./publish-dashboard');

const entries = [
  ['src/index.ts', 'dist/mcp-server.js'],
  ['src/broker-entry.ts', 'dist/arc-tunnel-broker.js'],
  ['src/broker-control.ts', 'dist/arc-tunnel-control.js']
];

async function build() {
  await Promise.all(entries.map(([entryPoint, outfile]) => esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    target: 'node22',
    outfile,
    sourcemap: true,
    sourcesContent: false
  })));
  publishDashboard();
  console.log('MCP server build complete');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exitCode = 1;
});

'use strict';

let buffer = '';
const failsafe = setTimeout(() => process.exit(9), 10_000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const newline = buffer.indexOf('\n');
  if (newline < 0) return;
  const request = JSON.parse(buffer.slice(0, newline));
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '1900-01-01',
        capabilities: {},
        serverInfo: { name: 'incompatible-test-peer', version: '1.0.0' }
      }
    }) + '\n');
  }, 100);
});
process.on('exit', () => clearTimeout(failsafe));

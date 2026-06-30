const fs = require('fs');
const http = require('http');
const port = Number(process.argv[2]);
const countFile = process.argv[3];
fs.appendFileSync(countFile, 'spawn\n');
const server = http.createServer((request, response) => {
  if (request.url !== '/health') { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ name: 'arc-tunnel', protocolVersion: 2, pid: process.pid, port }));
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));

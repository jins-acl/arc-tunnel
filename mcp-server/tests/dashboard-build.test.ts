import fs from 'fs';
import os from 'os';
import path from 'path';

const { publishDashboard } = require('../publish-dashboard');

describe('dashboard build publisher', () => {
  it('keeps committed source maps independent of checkout line endings', () => {
    for (const name of ['mcp-server.js.map', 'arc-tunnel-broker.js.map', 'arc-tunnel-control.js.map']) {
      const sourceMap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', name), 'utf8'));
      expect(sourceMap).not.toHaveProperty('sourcesContent');
    }
  });

  it('exports a testable dashboard publisher', () => {
    let module: unknown;
    try {
      module = require('../publish-dashboard');
    } catch {
      module = undefined;
    }
    expect(module).toEqual(expect.objectContaining({ publishDashboard: expect.any(Function) }));
  });

  it('keeps the previous dashboard when copying the replacement fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-dashboard-copy-'));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'dashboard');
    fs.mkdirSync(source);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(source, 'index.html'), 'new');
    fs.writeFileSync(path.join(destination, 'index.html'), 'old');
    const operations = Object.assign(Object.create(fs), {
      cpSync: () => { throw new Error('copy failed'); }
    });
    try {
      expect(() => publishDashboard({ source, destination, fs: operations, uniqueId: 'copy-failure' }))
        .toThrow('copy failed');
      expect(fs.readFileSync(path.join(destination, 'index.html'), 'utf8')).toBe('old');
      expect(fs.readdirSync(root).sort()).toEqual(['dashboard', 'source']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores the previous dashboard when the replacement rename fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-dashboard-rename-'));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'dashboard');
    fs.mkdirSync(source);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(source, 'index.html'), 'new');
    fs.writeFileSync(path.join(destination, 'index.html'), 'old');
    const operations = Object.assign(Object.create(fs), {
      renameSync: (from: string, to: string) => {
        if (from.includes('.tmp-') && to === destination) throw new Error('swap failed');
        fs.renameSync(from, to);
      }
    });
    try {
      expect(() => publishDashboard({ source, destination, fs: operations, uniqueId: 'rename-failure' }))
        .toThrow('swap failed');
      expect(fs.readFileSync(path.join(destination, 'index.html'), 'utf8')).toBe('old');
      expect(fs.readdirSync(root).sort()).toEqual(['dashboard', 'source']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

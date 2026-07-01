#!/usr/bin/env node
/**
 * Arc Tunnel — Multi-Agent Installer
 * Automatically detects installed AI agent tools and configures Arc Tunnel MCP server.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const MCP_SERVER_PATH = path.join(REPO_ROOT, 'mcp-server', 'dist', 'mcp-server.js');
const BROKER_PATH = path.join(REPO_ROOT, 'mcp-server', 'dist', 'arc-tunnel-broker.js');

// Normalize path for JSON/YAML (backslashes → forward slashes on Windows)
function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function log(msg) {
  console.log(`[arc-tunnel] ${msg}`);
}

function warn(msg) {
  console.warn(`[arc-tunnel] ⚠️  ${msg}`);
}

function success(msg) {
  console.log(`[arc-tunnel] ✅ ${msg}`);
}

// ─── Backup helper ───
function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const backupPath = `${filePath}.backup.${Date.now()}`;
  fs.copyFileSync(filePath, backupPath);
  log(`Backed up existing config: ${backupPath}`);
}

// ─── Agent detectors ───

const AGENTS = [
  {
    name: 'Claude Code',
    id: 'claude-code',
    configFile: () => path.join(os.homedir(), '.mcp.json'),
    templateFile: 'claude-code.json',
    detect: () => fs.existsSync(path.join(os.homedir(), '.claude')),
    merge: (existing, incoming) => {
      const data = existing ? JSON.parse(existing) : { mcpServers: {} };
      data.mcpServers = data.mcpServers || {};
      data.mcpServers['arc-tunnel'] = incoming.mcpServers['arc-tunnel'];
      return JSON.stringify(data, null, 2);
    }
  },
  {
    name: 'Hermes Agent',
    id: 'hermes',
    configFile: () => {
      const base = path.join(os.homedir(), '.hermes');
      return path.join(base, 'config.yaml');
    },
    templateFile: 'hermes.yaml',
    detect: () => {
      const home = os.homedir();
      return fs.existsSync(path.join(home, '.hermes')) ||
             fs.existsSync(path.join(home, 'Desktop', 'hermes-agent-2026.5.16'));
    },
    merge: (existing, incomingRaw) => {
      // Simple YAML merge: append/replace arc-tunnel section
      const marker = 'mcp_servers:';
      const serverBlock = incomingRaw.split('\n').slice(1).join('\n'); // remove first "mcp_servers:"
      if (!existing) {
        return incomingRaw;
      }
      let lines = existing.split('\n');
      const idx = lines.findIndex(l => l.trim() === 'mcp_servers:');
      if (idx === -1) {
        // No mcp_servers section exists — append at end
        return existing.trimEnd() + '\n\n' + incomingRaw;
      }
      // Remove existing arc-tunnel block under mcp_servers
      const newLines = [];
      let inArcTunnel = false;
      let indent = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i === idx) {
          newLines.push(line);
          continue;
        }
        if (inArcTunnel) {
          const currentIndent = line.length - line.trimStart().length;
          if (line.trim() === '' || currentIndent <= indent) {
            inArcTunnel = false;
          } else {
            continue; // skip existing arc-tunnel lines
          }
        }
        if (!inArcTunnel && line.trimStart().startsWith('arc-tunnel:')) {
          inArcTunnel = true;
          indent = line.length - line.trimStart().length;
          continue;
        }
        newLines.push(line);
      }
      // Insert new arc-tunnel block after mcp_servers:
      const insertIdx = newLines.findIndex(l => l.trim() === 'mcp_servers:') + 1;
      newLines.splice(insertIdx, 0, serverBlock);
      return newLines.join('\n');
    }
  },
  {
    name: 'OpenClaw',
    id: 'openclaw',
    configFile: () => path.join(os.homedir(), '.openclaw', 'openclaw.json'),
    templateFile: 'openclaw.json',
    detect: () => fs.existsSync(path.join(os.homedir(), '.openclaw')),
    merge: (existing, incoming) => {
      const data = existing ? JSON.parse(existing) : {};
      data.mcpServers = data.mcpServers || {};
      data.mcpServers['arc-tunnel'] = incoming.mcpServers['arc-tunnel'];
      return JSON.stringify(data, null, 2);
    }
  },
  {
    name: 'Kimi Code CLI',
    id: 'kimi',
    configFile: () => path.join(os.homedir(), '.mcp.json'),
    templateFile: 'claude-code.json', // Reuses same format
    detect: () => fs.existsSync(path.join(os.homedir(), '.kimi')),
    merge: null // Skip auto-merge, show manual instructions
  },
  {
    name: 'Codex (OpenAI)',
    id: 'codex',
    configFile: null,
    templateFile: 'codex-skill.yaml',
    detect: () => fs.existsSync(path.join(os.homedir(), '.codex')),
    merge: null // Skill-level, requires manual copy
  }
];

// ─── Main installer ───

function install() {
  log('Arc Tunnel Multi-Agent Installer');
  log(`Repository: ${REPO_ROOT}`);
  log('');

  const missingBundles = [MCP_SERVER_PATH, BROKER_PATH].filter(bundle => !fs.existsSync(bundle));
  if (missingBundles.length > 0) {
    missingBundles.forEach(bundle => warn(`Required bundle not found at ${bundle}`));
    warn('Run: cd mcp-server && npm install && npm run build');
    process.exit(1);
  }

  const detected = AGENTS.filter(a => a.detect());

  if (detected.length === 0) {
    warn('No supported AI agent tools detected on this system.');
    log('');
    log('Supported agents:');
    AGENTS.forEach(a => log(`  • ${a.name}`));
    log('');
    log('You can still manually copy configs from: configs/');
    process.exit(0);
  }

  log(`Detected ${detected.length} agent tool(s):`);
  detected.forEach(a => log(`  • ${a.name}`));
  log('');

  let installedCount = 0;

  for (const agent of detected) {
    log(`Configuring ${agent.name}...`);

    // Read template
    const templatePath = path.join(REPO_ROOT, 'configs', agent.templateFile);
    if (!fs.existsSync(templatePath)) {
      warn(`Template not found: ${templatePath}`);
      continue;
    }

    let templateRaw = fs.readFileSync(templatePath, 'utf-8');
    templateRaw = templateRaw.replace(/\{\{REPO_PATH\}\}/g, normalizePath(REPO_ROOT));

    // Agents that require manual setup
    if (!agent.merge) {
      if (agent.id === 'kimi') {
        log('  Kimi uses the same .mcp.json format as Claude Code.');
        const configPath = agent.configFile();
        if (fs.existsSync(configPath)) {
          log(`  Existing config found: ${configPath}`);
          log('  Please add the arc-tunnel section manually (see configs/kimi.md)');
        } else {
          backupFile(configPath);
          fs.writeFileSync(configPath, templateRaw, 'utf-8');
          success(`  Written: ${configPath}`);
          installedCount++;
        }
      } else if (agent.id === 'codex') {
        log('  Codex requires skill-level MCP dependency configuration.');
        log(`  See template: configs/${agent.templateFile}`);
        log('  Copy the dependencies block into your skill\'s agents/openai.yaml');
      }
      continue;
    }

    // Auto-merge agents
    const configPath = agent.configFile();
    let existing = null;
    if (fs.existsSync(configPath)) {
      existing = fs.readFileSync(configPath, 'utf-8');
      backupFile(configPath);
    }

    let merged;
    try {
      const templateData = agent.templateFile.endsWith('.json')
        ? JSON.parse(templateRaw)
        : templateRaw;
      merged = agent.merge(existing, templateData);
    } catch (err) {
      warn(`Failed to merge config: ${err.message}`);
      continue;
    }

    // Ensure directory exists
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    fs.writeFileSync(configPath, merged, 'utf-8');
    success(`  Written: ${configPath}`);
    installedCount++;
  }

  log('');
  log('──────────────────────────────');
  if (installedCount > 0) {
    success(`Installation complete! Configured ${installedCount} agent(s).`);
  } else {
    log('No automatic configurations were written.');
    log('Please refer to configs/ for manual setup templates.');
  }
  log('');
  log('Next steps:');
  log('  1. Load the browser extension: extension/dist/');
  log('  2. Open Chrome/Edge → chrome://extensions → Developer mode → Load unpacked');
  log('  3. Select the extension/dist folder');
  log('  4. Restart your AI agent tool');
  log('  5. The first MCP client starts one shared Broker; later clients connect to it.');
  log('     Manage it with: node scripts/start.js [start|status|stop] [--port N]');
  log('     For a custom port, use the same WS_PORT in every client config and');
  log('     select that port in the browser extension popup.');
  log('');
  log('Arc Tunnel is ready to use! 🚀');
}

install();

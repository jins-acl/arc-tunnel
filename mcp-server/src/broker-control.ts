import { BrokerInspection, ensureBroker, getBrokerStatus, inspectBroker, stopBroker } from './broker-launcher';
import { BrokerConfig, BrokerEndpointConfig, loadBrokerConfig, loadBrokerEndpointConfig } from './config';

interface Output { stdout(value: string): void; stderr(value: string): void }
interface ControlLauncher {
  homeDir?: string;
  ensureBroker?: (config: BrokerConfig) => ReturnType<typeof ensureBroker>;
  getBrokerStatus?: (config: BrokerEndpointConfig) => ReturnType<typeof getBrokerStatus>;
  stopBroker?: (config: BrokerEndpointConfig) => ReturnType<typeof stopBroker>;
  inspectBroker?: (config: BrokerEndpointConfig) => ReturnType<typeof inspectBroker>;
}

const defaultLauncher: ControlLauncher = {
  ensureBroker,
  getBrokerStatus,
  stopBroker,
  inspectBroker
};

const EXIT_CODE: Record<BrokerInspection['kind'], number> = {
  healthy: 0, absent: 2, foreign: 3, incompatible: 4, 'diagnostics-unavailable': 5
};

function diagnoseJson(inspection: BrokerInspection) {
  return inspection.kind === 'healthy'
    ? { running: true, ...inspection, dashboardUrl: `http://127.0.0.1:${inspection.port}/dashboard` }
    : { running: false, ...inspection };
}

function humanDiagnose(inspection: BrokerInspection): string {
  const dashboard = `http://127.0.0.1:${inspection.port}/dashboard`;
  const lines = ['Arc Tunnel 运维控制中心', '========================'];
  if (inspection.kind === 'healthy') {
    const d = inspection.diagnostics;
    lines.push(`Broker: 正常（PID ${inspection.pid}，端口 ${inspection.port}，协议 ${inspection.protocolVersion}，运行 ${d.broker.uptimeMs} ms）`);
    lines.push(`Extension: ${d.extension.connected ? '已连接' : '未连接'}`);
    lines.push(`Agent: 已连接 ${d.agents.connected}，宽限期 ${d.agents.grace}`);
    lines.push(`工作负载: 已认领标签页 ${d.workload.claimedTabs}，待处理命令 ${d.workload.pendingCommands}`);
    lines.push(`恢复阶段: 清单同步 ${d.recovery.inventorySync}，录制清理 ${d.recovery.recordingCleanup}`);
    lines.push(`最近错误: ${d.recentError ? `${d.recentError.code} ${d.recentError.summary}` : '无'}`);
    lines.push(`Dashboard: ${dashboard}`);
    lines.push('建议: 若浏览器未连接，请检查扩展弹窗中的 Broker 端口。');
  } else {
    let messages: string[];
    if (inspection.kind === 'absent') messages = [`Broker: 未运行（端口 ${inspection.port}）`, '建议: 运行 start 启动 Broker。'];
    else if (inspection.kind === 'foreign') messages = [`Broker: 端口 ${inspection.port} 被其他服务占用`, '建议: 选择空闲端口，且不要停止未知进程。'];
    else if (inspection.kind === 'incompatible') messages = [
      `Broker: 协议不兼容（当前 ${inspection.protocolVersion}，需要 ${inspection.expectedProtocolVersion}）`,
      '建议: 重新构建并统一更新 Broker、客户端和扩展。'
    ];
    else messages = [`Broker: 正常，但诊断接口不可用（PID ${inspection.pid}）`, '建议: 检查版本并重新构建 Broker bundle。'];
    lines.push(...messages, `Dashboard: ${dashboard}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runControl(
  argv: string[], env: Record<string, string | undefined>, output: Output,
  launcher: ControlLauncher = defaultLauncher
): Promise<number> {
  const action = argv[0] ?? 'start';
  if (action === 'start') {
    const config = loadBrokerConfig(argv.slice(1), env, launcher.homeDir);
    await launcher.ensureBroker!(config);
    output.stdout(`${JSON.stringify(await launcher.getBrokerStatus!(config))}\n`);
  } else if (action === 'status') {
    const config = loadBrokerEndpointConfig(argv.slice(1), env, launcher.homeDir);
    output.stdout(`${JSON.stringify(await launcher.getBrokerStatus!(config))}\n`);
  } else if (action === 'stop') {
    const config = loadBrokerEndpointConfig(argv.slice(1), env, launcher.homeDir);
    await launcher.stopBroker!(config);
    output.stdout(`${JSON.stringify({ running: false, port: config.port })}\n`);
  } else if (action === 'diagnose') {
    const config = loadBrokerEndpointConfig(argv.slice(1), env, launcher.homeDir);
    const inspection = await launcher.inspectBroker!(config);
    output.stdout(argv.includes('--json') ? `${JSON.stringify(diagnoseJson(inspection))}\n` : humanDiagnose(inspection));
    return EXIT_CODE[inspection.kind];
  } else {
    throw new Error(`Unknown broker action: ${action}`);
  }
  return 0;
}

async function main(): Promise<void> {
  process.exitCode = await runControl(process.argv.slice(2), process.env, {
    stdout: value => process.stdout.write(value), stderr: value => process.stderr.write(value)
  });
}

if (require.main === module) void main().catch((error) => {
  console.error(error); process.exitCode = 1;
});

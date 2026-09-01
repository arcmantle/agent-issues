import { execFileSync } from 'node:child_process';

const packages = [
  '@agent-issues/core',
  '@agent-issues/api-local',
  '@agent-issues/api-pg',
  '@agent-issues/site',
  '@agent-issues/kanban',
  'agent-issues',
  'agent-issues-mcp',
  'agent-issues-mcp-provider',
];

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

for (const packageName of packages) {
  execFileSync(pnpm, ['--filter', packageName, 'build'], {
    stdio: 'inherit',
  });
}
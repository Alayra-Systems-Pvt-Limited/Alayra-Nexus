import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const STANDALONE_PORT = 3120;
export const STANDALONE_BASE_URL = `http://127.0.0.1:${STANDALONE_PORT}`;
export const STANDALONE_MOCK_PORT = 3121;
export const STANDALONE_MOCK_URL = `http://127.0.0.1:${STANDALONE_MOCK_PORT}`;
export const STANDALONE_ADMIN_PASSWORD = 'standalone-browser-master-password';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const children: ChildProcess[] = [];
let tearingDown = false;

function run(command: string, label: string): void {
  console.log(`[standalone e2e] ${label}`);
  execSync(command, { cwd: REPO_ROOT, env: process.env, stdio: 'inherit' });
}

function launch(entry: string, env: NodeJS.ProcessEnv, cwd: string, label: string): ChildProcess {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tail = '';
  const keep = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-5000); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  child.on('exit', (code) => {
    if (!tearingDown && code !== null && code !== 0) {
      console.error(`[standalone e2e] ${label} exited with code ${code}. Last output:\n${tail}`);
    }
  });
  children.push(child);
  return child;
}

async function waitForHealth(url: string, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become healthy at ${url}/health within 60 seconds`);
}

function stopAll(dataDir: string): void {
  tearingDown = true;
  for (const child of children) {
    if (child.pid && !child.killed) {
      if (process.platform === 'win32') {
        try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
      } else {
        child.kill('SIGTERM');
      }
    }
  }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows can release late */ }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!process.env.E2E_SKIP_BUILD) {
    run('npm run build', 'building the gateway');
    run('npm --prefix web run build', 'building the dashboard');
  }

  const serverEntry = path.join(REPO_ROOT, 'dist', 'server.js');
  const mockEntry = path.join(REPO_ROOT, 'e2e', 'setup', 'mock-provider.mjs');
  const dashboardEntry = path.join(REPO_ROOT, 'web', 'dist', 'index.html');
  for (const artifact of [serverEntry, mockEntry, dashboardEntry]) {
    if (!existsSync(artifact)) throw new Error(`Required standalone e2e artifact is missing: ${artifact}`);
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), 'nexus-browser-'));
  process.env.NEXUS_STANDALONE_E2E_DATA_DIR = dataDir;

  const gatewayEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NEXUS_MODE: '',
    USAGE_FLUSH_MAX: '1',
    NEXUS_DATA_DIR: dataDir,
    PORT: String(STANDALONE_PORT),
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    ADMIN_PASSWORD: STANDALONE_ADMIN_PASSWORD,
    MASTER_ENCRYPTION_KEY: 'b'.repeat(64),
    SSRF_ALLOWLIST: '127.0.0.1',
    LOG_LEVEL: 'warn',
  };
  delete gatewayEnv.DATABASE_URL;
  delete gatewayEnv.REDIS_URL;

  try {
    launch(mockEntry, { ...process.env, PORT: String(STANDALONE_MOCK_PORT) }, REPO_ROOT, 'mock provider');
    launch(serverEntry, gatewayEnv, dataDir, 'standalone gateway');
    await waitForHealth(STANDALONE_MOCK_URL, 'mock provider');
    await waitForHealth(STANDALONE_BASE_URL, 'standalone gateway');
    console.log(`[standalone e2e] gateway and mock provider are healthy; data is isolated in ${dataDir}`);
  } catch (error) {
    stopAll(dataDir);
    throw error;
  }

  return async () => stopAll(dataDir);
}

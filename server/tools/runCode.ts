import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type RunCodeInput = {
  code: string;
  dataFile: string;
  dataFiles?: string[];
  workDir: string;
  signal?: AbortSignal;
};

export type RunCodeResult = {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  dataFile: string;
  dataFiles: string[];
  workDir: string;
  stdout: string;
  stderr: string;
  artifacts: Array<{ name: string; path: string; preview?: string }>;
};

const MAX_OUTPUT = 24_000;
const MAX_PREVIEW = 8_000;
const TIMEOUT_MS = 45_000;

export async function runCode(input: RunCodeInput): Promise<RunCodeResult> {
  const dataFiles = input.dataFiles?.length ? input.dataFiles : [input.dataFile];
  await mkdir(input.workDir, { recursive: true });
  const scriptPath = path.join(input.workDir, 'analysis.py');
  const wrappedCode = [
    'import json',
    'import os',
    `DATA_FILE = ${JSON.stringify(input.dataFile)}`,
    `DATA_FILES = ${JSON.stringify(dataFiles)}`,
    `WORK_DIR = ${JSON.stringify(input.workDir)}`,
    'os.makedirs(WORK_DIR, exist_ok=True)',
    input.code
  ].join('\n');

  await writeFile(scriptPath, wrappedCode, 'utf8');

  return await new Promise<RunCodeResult>((resolve) => {
    const child = spawn('python', [scriptPath], {
      cwd: input.workDir,
      env: {
        ...process.env,
        DATA_FILE: input.dataFile,
        DATA_FILES: JSON.stringify(dataFiles),
        WORK_DIR: input.workDir,
        PYTHONIOENCODING: 'utf-8'
      },
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);
    const abortHandler = () => {
      timedOut = true;
      child.kill();
    };
    input.signal?.addEventListener('abort', abortHandler, { once: true });

    child.stdout.on('data', (chunk) => {
      stdout = trimOutput(stdout + chunk.toString());
    });

    child.stderr.on('data', (chunk) => {
      stderr = trimOutput(stderr + chunk.toString());
    });

    child.on('error', async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abortHandler);
      resolve({
        ok: false,
        exitCode: null,
        timedOut,
        dataFile: input.dataFile,
        dataFiles,
        workDir: input.workDir,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        artifacts: await collectArtifacts(input.workDir)
      });
    });

    child.on('close', async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abortHandler);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        timedOut,
        dataFile: input.dataFile,
        dataFiles,
        workDir: input.workDir,
        stdout,
        stderr,
        artifacts: await collectArtifacts(input.workDir)
      });
    });
  });
}

function trimOutput(value: string): string {
  if (value.length <= MAX_OUTPUT) return value;
  return `${value.slice(0, MAX_OUTPUT)}\n...[output truncated]`;
}

async function collectArtifacts(workDir: string): Promise<RunCodeResult['artifacts']> {
  const entries = await readdir(workDir, { withFileTypes: true });
  const artifacts: RunCodeResult['artifacts'] = [];

  for (const entry of entries) {
    if (!entry.isFile() || entry.name === 'analysis.py') continue;
    const artifactPath = path.join(workDir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();
    const textLike = ['.json', '.md', '.txt', '.csv', '.mmd'].includes(ext);
    let preview: string | undefined;

    if (textLike) {
      try {
        const content = await readFile(artifactPath, 'utf8');
        preview = content.slice(0, MAX_PREVIEW);
      } catch {
        preview = undefined;
      }
    }

    artifacts.push({ name: entry.name, path: artifactPath, preview });
  }

  return artifacts;
}

import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { win32 } from 'node:path';

import { parseCaddyAdminSocketPath } from '../config/env.js';

const ROUTES_PATH = '/config/apps/http/servers/deployflow/routes';
const MAX_BYTES = 1024 * 1024;
export const CADDY_REQUEST_TIMEOUT_MS = 2_000;

type AdminRequest =
  | { method: 'GET' }
  | { method: 'PATCH'; body: string; etag: string };

export type CaddyAdminResponse = {
  status: number;
  body: string;
  etag: string | undefined;
};

export type CaddyAdminTransport = (
  input: AdminRequest,
  timeoutMs?: number,
) => Promise<CaddyAdminResponse>;

export const isRoutesEtag = (value: string | undefined): value is string =>
  value !== undefined && /^"\/config\/apps\/http\/servers\/deployflow\/routes [a-f0-9]{1,64}"$/i.test(value);

const requestHeaders = (input: AdminRequest): Record<string, string> =>
  input.method === 'GET'
    ? {}
    : {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(input.body)),
        'If-Match': input.etag,
      };

const requestWithNode = (
  socketPath: string,
  input: AdminRequest,
  timeoutMs: number,
): Promise<CaddyAdminResponse> =>
  new Promise((resolve, reject) => {
    const req = request({
      socketPath,
      method: input.method,
      path: ROUTES_PATH,
      headers: requestHeaders(input),
      agent: false,
    });
    const timer = setTimeout(() => req.destroy(new Error('Caddy admin request timed out')), timeoutMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    req.once('error', fail);
    req.once('response', (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          const error = new Error('Caddy admin response exceeded the size limit');
          fail(error);
          req.destroy(error);
        } else {
          chunks.push(chunk);
        }
      });
      response.once('error', fail);
      response.once('end', () => {
        clearTimeout(timer);
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          etag: response.headers.etag,
        });
      });
    });
    req.end(input.method === 'PATCH' ? input.body : undefined);
  });

const parseCurlResponse = (output: string): CaddyAdminResponse => {
  const separator = output.indexOf('\r\n\r\n');
  if (separator < 0) throw new Error('Caddy admin response was not valid HTTP');
  const headers = output.slice(0, separator);
  const status = /^HTTP\/1\.[01] (\d{3})[ \r]/.exec(headers)?.[1];
  if (status === undefined) throw new Error('Caddy admin response had no HTTP status');
  const etag = /^etag:[ \t]*([^\r\n]+)\r?$/im.exec(headers)?.[1]?.trim();
  return { status: Number(status), body: output.slice(separator + 4), etag };
};

const requestWithCurl = (
  executable: string,
  socketPath: string,
  input: AdminRequest,
  timeoutMs: number,
): Promise<CaddyAdminResponse> =>
  new Promise((resolve, reject) => {
    const args = [
      '-q', '--silent', '--show-error', '--http1.1', '--include',
      '--noproxy', '*', '--proto', '=http', '--unix-socket', socketPath,
      '--max-time', String(timeoutMs / 1000), '--request', input.method,
    ];
    if (input.method === 'PATCH') {
      args.push('--header', 'Content-Type: application/json', '--header', 'Expect:',
        '--header', 'If-Match: ' + input.etag, '--data-binary', '@-');
    }
    args.push('http://localhost' + ROUTES_PATH);

    const child = spawn(executable, args, { shell: false, windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => { fail(new Error('Caddy admin request timed out')); }, timeoutMs);
    function fail(error: Error): void {
      clearTimeout(timer);
      child.kill();
      reject(error);
    }
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        fail(new Error('Caddy admin response exceeded the size limit'));
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.resume();
    child.once('error', fail);
    child.stdin.once('error', fail);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('Caddy admin curl request failed (exit ' + String(code) + ')'));
        return;
      }
      try {
        resolve(parseCurlResponse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Caddy admin response could not be parsed'));
      }
    });
    child.stdin.end(input.method === 'PATCH' ? input.body : undefined);
  });

export const createCaddyAdminTransport = (rawSocketPath: string): CaddyAdminTransport => {
  const socketPath = parseCaddyAdminSocketPath(rawSocketPath);
  const windows = process.platform === 'win32';
  const systemRoot = process.env.SystemRoot ?? '';
  if (
    windows &&
    (!/^[a-z]:\\[^:*?"<>|]+$/i.test(systemRoot) ||
      Array.from(systemRoot).some((character) => character.charCodeAt(0) < 32))
  ) {
    throw new Error('An absolute Windows SystemRoot is required for the Caddy admin transport');
  }
  const curl = win32.join(systemRoot, 'System32', 'curl.exe');
  return async (input, timeoutMs = CADDY_REQUEST_TIMEOUT_MS) => {
    if (
      input.method === 'PATCH' &&
      (!isRoutesEtag(input.etag) || Buffer.byteLength(input.body) > MAX_BYTES)
    ) {
      throw new Error('Caddy admin update exceeded the request limits or used an invalid ETag');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > CADDY_REQUEST_TIMEOUT_MS) {
      throw new Error('Caddy admin timeout is outside its permitted bounds');
    }
    return windows
      ? requestWithCurl(curl, socketPath, input, timeoutMs)
      : requestWithNode(socketPath, input, timeoutMs);
  };
};

import { readFile } from 'node:fs/promises';

export const LINUX_BOOT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export async function readLinuxBootId(): Promise<string> {
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (!LINUX_BOOT_ID.test(bootId)) throw new Error('Unable to verify the Linux host boot ID');
  return bootId;
}

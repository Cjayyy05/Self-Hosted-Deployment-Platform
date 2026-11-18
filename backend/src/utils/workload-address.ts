// The dedicated 127.64/10 pool never includes localhost or a pre-Phase-1 binding.
export const MAX_WORKLOAD_ADDRESS = 4_194_303;
export const RESERVED_WORKLOAD_PORT = 787;

export function workloadAddress(index: number | null | undefined): string {
  if (index == null) return '127.0.0.1';
  if (!Number.isInteger(index) || index < 1 || index > MAX_WORKLOAD_ADDRESS) {
    throw new Error('Invalid public workload address');
  }
  return ['127', 64 + (index >>> 16), (index >>> 8) & 255, index & 255].join('.');
}

export const isWorkloadAddress = (address: string): boolean => {
  const [prefix, region, third, fourth, extra] = address.split('.');
  return extra === undefined && prefix === '127' && region !== undefined && third !== undefined && fourth !== undefined &&
    [region, third, fourth].every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255) &&
    Number(region) >= 64 && Number(region) <= 127 && address !== '127.64.0.0';
};

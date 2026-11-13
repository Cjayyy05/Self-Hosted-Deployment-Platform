import { describe, expect, it } from 'vitest';

import { localProjectUrl, projectHostnameLabel } from '../src/utils/project-hostname.js';

describe('stable project hostnames', () => {
  it('uses the entire UUID independent of case', () => {
    const id = 'A382FB3D-DCE4-4470-8E41-89A181466CE8';
    expect(projectHostnameLabel(id)).toBe('app-a382fb3ddce444708e4189a181466ce8');
    expect(projectHostnameLabel(id.toLowerCase())).toBe(projectHostnameLabel(id));
    expect(projectHostnameLabel(id.replace(/8$/, '9'))).not.toBe(projectHostnameLabel(id));
  });

  it('rejects inputs other than a canonical UUID', () => {
    expect(() => projectHostnameLabel('other.localhost')).toThrow('UUID');
  });

  it('preserves the local listener port and uses the configured suffix', () => {
    expect(localProjectUrl('app-a382fb3ddce444708e4189a181466ce8', {
      origin: 'http://127.0.0.1:8180',
      hostnameSuffix: 'apps.localhost',
    })).toBe('http://app-a382fb3ddce444708e4189a181466ce8.apps.localhost:8180');
  });
});

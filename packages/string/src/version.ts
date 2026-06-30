import { readFileSync } from 'fs';

interface PackageJson {
  version?: string;
}

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
) as PackageJson;

export const STRING_VERSION = packageJson.version ?? '0.0.0';

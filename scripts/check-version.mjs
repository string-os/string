#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';

const root = process.cwd();

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf-8'));
}

function fail(message) {
  failures.push(message);
}

function expectEqual(label, actual, expected) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
}

function expectMcp(file, version) {
  const json = readJson(file);
  const args = json.mcpServers?.string?.args ?? [];
  const pkgArg = args.find(arg => typeof arg === 'string' && arg.startsWith('@string-os/string@'));
  expectEqual(`${file} mcp package`, pkgArg, `@string-os/string@${version}`);
}

const failures = [];
const version = readJson('packages/string/package.json').version;

expectEqual('package.json version', readJson('package.json').version, version);

for (const file of [
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  'plugins/string/.codex-plugin/plugin.json',
]) {
  expectEqual(`${file} version`, readJson(file).version, version);
}

for (const file of [
  '.codex-plugin/marketplace.json',
  '.claude-plugin/marketplace.json',
]) {
  const json = readJson(file);
  expectEqual(`${file} metadata.version`, json.metadata?.version, version);
  expectEqual(`${file} plugins[0].version`, json.plugins?.[0]?.version, version);
}

for (const file of ['.mcp.json', 'plugins/string/.mcp.json']) {
  expectMcp(file, version);
}

expectEqual('.codex-plugin/plugin.json mcpServers', readJson('.codex-plugin/plugin.json').mcpServers, './.mcp.json');
expectEqual('.claude-plugin/plugin.json mcpServers', readJson('.claude-plugin/plugin.json').mcpServers, './.mcp.json');

if (failures.length > 0) {
  console.error('String version coherence check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`String version coherence ok: ${version}`);

#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve the repo root from this script's own location (scripts/check-version.mjs),
// NOT from process.cwd(): a prepublishOnly hook runs with the cwd set to the package
// being published, so a cwd-relative root would read the wrong tree (or none). This
// gate must give the same answer no matter which directory invokes it.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// ── Publishable workspace packages release in lockstep with @string-os/string ──
// The keel incident (string#47): @string-os/client's src gained autoAck in #60 but its
// package version stayed 0.1.3, and @string-os/string depended on "^0.1.3", so every
// consumer kept resolving the pre-autoAck 0.1.3 artifact — a package whose code moved on
// but whose version never did, so the fix could never ship (npm won't republish 0.1.3).
// Guard it the way the manifests are already guarded: every publishable workspace package,
// and every internal @string-os/* dependency edge, must carry the single release version
// EXACTLY — an exact pin, no caret, so a release can't resolve onto a stale cached build.
const internalDepKinds = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
for (const entry of fs.readdirSync(path.join(root, 'packages')).sort()) {
  const manifest = path.join('packages', entry, 'package.json');
  if (!fs.existsSync(path.join(root, manifest))) continue;
  const pkg = readJson(manifest);
  if (pkg.private) continue; // only packages that actually publish must stay in lockstep
  expectEqual(`${manifest} version`, pkg.version, version);
  for (const kind of internalDepKinds) {
    for (const [name, range] of Object.entries(pkg[kind] ?? {})) {
      if (!name.startsWith('@string-os/')) continue;
      // Must equal the release version with no range operator (e.g. "0.1.15", not "^0.1.15").
      expectEqual(`${manifest} ${kind}[${name}] exact pin`, range, version);
    }
  }
}

if (failures.length > 0) {
  console.error('String version coherence check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`String version coherence ok: ${version}`);

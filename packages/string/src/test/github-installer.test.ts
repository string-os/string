/**
 * Tests for the GitHub URL recognizer (parseGithubUrl).
 *
 * Pure-function tests only — no network. The synthesizeGithubSource path
 * is covered indirectly by the higher-level install smoke tests.
 */
import { assert, section } from './runner.js';
import { parseGithubUrl } from '../github-installer.js';

await section('parseGithubUrl — tree URL with ref', async () => {
  const r = parseGithubUrl('https://github.com/string-os/apps/tree/main/apps/gh-kanban');
  assert(r !== null, 'parsed');
  assert(r?.kind === 'tree', 'kind=tree');
  assert(r?.owner === 'string-os', 'owner');
  assert(r?.repo === 'apps', 'repo');
  assert(r?.ref === 'main', 'ref=main');
  assert(r?.path === 'apps/gh-kanban', 'path');
});

await section('parseGithubUrl — blob URL is single-file', async () => {
  const r = parseGithubUrl('https://github.com/owner/repo/blob/v1.2/apps/foo/string.md');
  assert(r !== null, 'parsed');
  assert(r?.kind === 'blob', 'kind=blob');
  assert(r?.ref === 'v1.2', 'ref preserves tag');
  assert(r?.path === 'apps/foo/string.md', 'path includes filename');
});

await section('parseGithubUrl — repo root has null ref (resolve later)', async () => {
  const r = parseGithubUrl('https://github.com/owner/repo');
  assert(r !== null, 'parsed');
  assert(r?.kind === 'tree', 'repo root treated as tree');
  assert(r?.ref === null, 'ref=null signals "default branch"');
  assert(r?.path === '', 'path is empty for repo root');
});

await section('parseGithubUrl — gh: short form', async () => {
  const r = parseGithubUrl('gh:string-os/apps/apps/gh-kanban');
  assert(r !== null, 'parsed');
  assert(r?.owner === 'string-os' && r?.repo === 'apps', 'owner/repo');
  assert(r?.path === 'apps/gh-kanban', 'path joined from remaining segments');
  assert(r?.ref === null, 'short form without @ref defaults to null');
});

await section('parseGithubUrl — gh: short form with @ref', async () => {
  const r = parseGithubUrl('gh:owner/repo/apps/foo@v1.0');
  assert(r?.ref === 'v1.0', 'ref extracted from @suffix');
  assert(r?.path === 'apps/foo', 'path stripped of @ref');
});

await section('parseGithubUrl — gh: short form, no path, with @ref', async () => {
  const r = parseGithubUrl('gh:owner/repo@dev');
  assert(r?.owner === 'owner' && r?.repo === 'repo', 'owner/repo parsed');
  assert(r?.ref === 'dev', 'ref=dev');
  assert(r?.path === '', 'empty path');
});

await section('parseGithubUrl — rejects non-GitHub URLs', async () => {
  assert(parseGithubUrl('https://example.com/owner/repo') === null, 'other host');
  assert(parseGithubUrl('https://raw.githubusercontent.com/o/r/main/f.md') === null, 'raw URL not recognized (single-file path handles raw URLs as plain HTTP)');
  assert(parseGithubUrl('./local-path.md') === null, 'local path');
  assert(parseGithubUrl('') === null, 'empty');
});

await section('parseGithubUrl — rejects malformed github paths', async () => {
  assert(parseGithubUrl('https://github.com/onlyowner') === null, 'missing repo');
  assert(parseGithubUrl('https://github.com/o/r/wiki/page') === null, 'kind != tree/blob');
  assert(parseGithubUrl('https://github.com/o/r/tree') === null, 'tree without ref');
});

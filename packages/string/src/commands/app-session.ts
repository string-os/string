import type { Loader } from '../loader.js';
import type { Session } from '../session.js';
import type { CommandResult } from '../types.js';
import { parseTopic } from '../types.js';
import { resolve } from '../resolver.js';
import { render } from '../renderer.js';
import { deriveEnvScope } from '../env-store.js';
import { err } from './helpers.js';

/**
 * App topics have a canonical installed document. Load it into the session
 * without running the app's default action, so /act and /nav can work directly
 * from `string app:<name> "/act.foo ..."` without requiring /open first.
 */
export async function hydrateAppDocument(
  session: Session,
  loader: Loader,
): Promise<CommandResult | null> {
  if (session.currentDoc) return null;

  const parsed = parseTopic(session.name);
  if (parsed?.type !== 'app') return null;

  const appName = parsed.namespace.split(':')[0];
  const registeredUri = loader.envStore.getPackage('apps', appName);
  if (!registeredUri) {
    const installed = Object.keys(loader.envStore.listPackages('apps'));
    const hint = installed.length
      ? `\nInstalled apps: ${installed.join(', ')}`
      : '\nNo apps installed yet. Use /install <source> to add one.';
    return err(
      `App '${appName}' is not installed. Run /install <source> to install it.${hint}`,
      'NOT_FOUND',
    );
  }

  const loaded = await loader.load(registeredUri);
  const doc = await resolve(loaded.uri, loaded.source, loader, undefined, loaded.rawSource);
  session.open(doc);

  const envScope = deriveEnvScope(session.name);
  const { autoShortcuts } = await render(doc, undefined, loader.home, loader, envScope);
  session.setAutoShortcuts(autoShortcuts);
  return null;
}

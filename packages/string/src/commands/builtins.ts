/**
 * Global slash commands.
 *
 * App/document action shorthand (`/send` for `/act.send`) must never shadow
 * these names. Topic-local verbs such as event `/read` or agent `/list` are
 * intentionally not included here: they are first-class only inside that topic,
 * and ordinary documents/apps may still expose actions with those names.
 */
export const GLOBAL_COMMANDS = new Set([
  'help',
  'open',
  'nav',
  'act',
  'back',
  'close',
  'refresh',
  'info',
  'source',
  'ls',
  'write',
  'append',
  'replace',
  'edit',
  'verify',
  'undo',
  'set',
  'exec',
  'install',
  'uninstall',
  'events',
]);

export function actionCommand(id: string): string {
  return GLOBAL_COMMANDS.has(id.toLowerCase()) ? `/act.${id}` : `/${id}`;
}

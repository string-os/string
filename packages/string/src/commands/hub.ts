/**
 * Hub topics — aggregator views over canonical session kinds.
 *
 * A hub is a reserved bare topic name (`app`, `bash`, `tool`, `system`)
 * that lists / manages instances of its kind. v1 ships placeholder
 * messages; concrete listings and management actions land in a follow-up.
 */

/**
 * Render the placeholder page shown when a user enters a hub topic with
 * no command. Each hub gets a one-line description and a hint at the
 * planned management surface.
 */
export function renderHubPlaceholder(hubName: string): string {
  switch (hubName) {
    case 'app':
      return [
        '# app hub',
        '',
        'Manage installed apps and currently open app sessions.',
        '',
        'Open a specific app:',
        '  /open app:<name>',
        '',
        '_Hub UI coming in a follow-up release._',
      ].join('\n');
    case 'bash':
      return [
        '# bash hub',
        '',
        'Manage active bash sessions across this user.',
        '',
        'Open a specific bash session:',
        '  /open bash:<name>',
        '  string bash:<name> "<command>"',
        '',
        '_Hub UI coming in a follow-up release._',
      ].join('\n');
    case 'tool':
      return [
        '# tool hub',
        '',
        'Browse installed tools.',
        '',
        'Run a tool:',
        '  /tool:<name>',
        '  /tool:<name>.<action>',
        '',
        '_Hub UI coming in a follow-up release._',
      ].join('\n');
    case 'system':
      return [
        '# system hub',
        '',
        'Daemon controls, env-store, and runtime state.',
        '',
        'Until the hub UI ships, use existing commands:',
        '  string --daemon status',
        '  /set                    — list session vars',
        '  /set $VAR = "..."       — set a session var',
        '',
        '_Hub UI coming in a follow-up release._',
      ].join('\n');
    default:
      // Defensive: parseTopic only returns hub for the four reserved names,
      // so reaching this branch means a runtime bug or extension. Surface
      // it rather than silently returning something benign.
      return `Unknown hub: ${hubName}\nValid hubs: app, bash, tool, system`;
  }
}

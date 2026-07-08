/**
 * String — Integration Tests
 * Tests Browser, Session, Commands, Renderer end-to-end.
 *
 * ESM imports execute top-level awaits sequentially.
 */
import './navigation.test.js';
import './actions.test.js';
import './topics-shell.test.js';
import './editing.test.js';
import './env-store.test.js';
import './packages.test.js';
import './references.test.js';
import './client.test.js';
import './agent-config.test.js';
import './agent-cli.test.js';
import './capability.test.js';
import './capability-issuance.test.js';
import './describe.test.js';
import './events.test.js';
import './fs.test.js';
import './recovery.test.js';
import './misc.test.js';
import { printSummary } from './runner.js';
printSummary();

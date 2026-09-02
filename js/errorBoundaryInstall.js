/**
 * @module errorBoundaryInstall
 * Standalone entry script whose ONLY job is to install the global error
 * boundary before the application's module graph is evaluated.
 *
 * Why this exists as its own <script type="module"> rather than a call at the
 * top of main.js: ESM hoists imports. `installErrorBoundary()` written as the
 * first statement of main.js does NOT run first — every one of main.js's ~20
 * imported modules is fully evaluated before that statement executes, so a
 * module-scope throw in any of them escapes uncaught. The boundary never
 * installs, `initMap()` never runs, `_showFatalBootError()` never renders, and
 * the rider gets a permanently stuck loading splash with no telemetry.
 *
 * Nothing throws at module scope today (that was checked), so this is a latent
 * contract violation rather than a live bug — but the comment in main.js
 * asserted the opposite, which is exactly the kind of claim that gets trusted
 * by the next person adding a module-scope statement.
 *
 * Separate module scripts execute in document order, and each graph is
 * evaluated in full before the next begins, so listing this before main.js in
 * index.html gives the guarantee the old comment claimed. Kept deliberately
 * dependency-light: this graph is errorBoundary.js -> feedStats.js -> utils.js,
 * all leaves with no DOM access at module scope.
 *
 * Do NOT add imports here, and do NOT move the call back into main.js.
 */

import { installErrorBoundary } from './errorBoundary.js';

installErrorBoundary();

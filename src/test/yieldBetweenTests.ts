import { afterEach } from 'vitest'

/*
 * Give the test worker's event loop one macrotask between tests.
 *
 * The router tests are synchronous and heavy: a file of them can run for more
 * than a minute with only microtask breaks between tests. The worker's report
 * to the runner ("onTaskUpdate") waits for a reply that arrives as a
 * macrotask, and times out after 60 s — an "Unhandled Error" that failed the
 * run although every test passed (seen on the 8f21d4d baseline as well). One
 * setImmediate per test lets the reply in. No test's behaviour changes.
 */
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)))

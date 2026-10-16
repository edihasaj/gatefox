import { after, before } from "node:test";
import { setOwnPidForTests } from "../boot-identity.js";

/**
 * Call once from a test file that starts a shared executor host inside the test process. That host's
 * receipt names this very pid, and the ownership rule reads a receipt naming our own pid as the leftover
 * of a failed start, so the running host would look dead to its own client. In production the host is a
 * process of its own and nothing here changes: the rule is only aimed at a pid no process can be holding,
 * which is compared and never signalled. Restored when the file's tests end.
 */
export function hostRunsInThisProcess(): void {
  before(() => setOwnPidForTests(process.pid + 1_000_000));
  after(() => setOwnPidForTests());
}

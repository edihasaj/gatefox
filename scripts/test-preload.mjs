// Loaded into every test process by run-tests.mjs (node --import). A signal ends a test process through process.exit, which runs
// its `exit` handlers, instead of through Node's default action, which skips them: the handlers are what stop the Copilot CLI
// process groups a test started (src/providers/copilot-client.ts stopCopilotClientsNow) and remove their folders, so a stopped
// run (Ctrl-C, a CI cancel, a terminal that closed) leaves none of them behind. The exit code is the shell's, 128 plus the signal.
for (const [name, number] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]) process.on(name, () => process.exit(128 + number));

// Node's test runner starts every test file with `--report-signal=SIGUSR2`, and that flag alone turns report-on-signal on, so a
// single SIGUSR2 to a test process (an idle-restart test that signals itself or a stale pid) would write a diagnostic report,
// environment values included, into the working folder: the repository. Reports on a signal are off in every test process, and
// any report one still writes goes to the run's private temp folder, which the runner removes when the run ends.
process.report.reportOnSignal = false;
const reports = process.env.GATEWAY_TEST_TMPDIR || process.env.TMPDIR;
if (reports) process.report.directory = reports;

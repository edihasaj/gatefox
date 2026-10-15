// Loaded into every test process by run-tests.mjs (node --import). A signal ends a test process through process.exit, which runs
// its `exit` handlers, instead of through Node's default action, which skips them: the handlers are what stop the Copilot CLI
// process groups a test started (src/providers/copilot-client.ts stopCopilotClientsNow) and remove their folders, so a stopped
// run (Ctrl-C, a CI cancel, a terminal that closed) leaves none of them behind. The exit code is the shell's, 128 plus the signal.
for (const [name, number] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]) process.on(name, () => process.exit(128 + number));

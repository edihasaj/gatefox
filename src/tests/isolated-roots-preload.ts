// Loaded with `node --import` into a child process a test starts (see isolated-execution-roots.ts), so a host that child runs
// keeps its SDK rendezvous, host homes and native-home receipts in the test's own folder. Only test code reads this variable;
// production never takes these roots from the environment.
import { setExecutionHostRootForTests, setSdkSocketRootForTests } from "../execution-host-storage.js";
import { setNativeOwnerRootForTests } from "../native-execution-host-storage.js";

const roots = JSON.parse(process.env.GATEWAY_TEST_EXECUTION_ROOTS ?? "{}") as { sdk?: string; hosts?: string; native?: string };
if (!roots.sdk || !roots.hosts || !roots.native) throw new Error("isolated-roots-preload needs the roots of isolateExecutionRoots");
setSdkSocketRootForTests(roots.sdk); setExecutionHostRootForTests(roots.hosts); setNativeOwnerRootForTests(roots.native);

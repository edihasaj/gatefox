import { basename, dirname, join } from "node:path";

/** The app bundle name since 1.8.0. */
export const appBundleName = "GateFox.app";
/** The bundle name releases before 1.8.0 installed. An update keeps that path until the 1.8.0 app renames itself. */
export const legacyAppBundleName = "Harness Gateway.app";
/** Both names a signed gateway app may have on disk. */
export const appBundleNames: readonly string[] = [appBundleName, legacyAppBundleName];

/**
 * The path a renamed GateFox app had before it renamed itself: the `Harness Gateway.app` beside it. The service
 * plist and the app-runtime link may still name that path once, and only it, until the renamed app rebinds them.
 */
export function retiredAppPath(app: string): string | undefined {
  return basename(app) === appBundleName ? join(dirname(app), legacyAppBundleName) : undefined;
}

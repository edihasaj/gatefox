import { basename, dirname, isAbsolute, normalize, resolve, sep } from "node:path";

/** The name `prepareDesktop` gives a generated wrapper: `desktop-wrapper-` plus 16 lowercase hex digits. */
const wrapperName = /^desktop-wrapper-[0-9a-f]{16}$/;

/**
 * The one spelling rule every component uses to decide whether a path names a gateway desktop wrapper: an
 * absolute, already-normalised path, with no trailing separator, whose parent is exactly `stateDirectory` and
 * whose basename is exactly a generated wrapper name. A look-alike stays foreign: the same name in another
 * directory or in a subdirectory of the state directory, a name with a prefix or suffix, a short, non-hex, or
 * uppercase suffix, and a path that climbs back through `..` or ends in a slash.
 *
 * Name only. What the entry actually is, and who owns it, is the caller's business: registration checks the file
 * type and uid with `lstat` before it replaces a `launchctl` value, while the launcher compares names alone
 * because an inherited path leaves the wrapper to decide whether a legacy `CODEX_APP_SERVER_FORCE_CLI=1` came
 * from us.
 */
export const isOwnWrapperPath = (path: string, stateDirectory: string): boolean =>
  isAbsolute(path) && !path.endsWith(sep) && normalize(path) === path
  && dirname(path) === resolve(stateDirectory) && wrapperName.test(basename(path));

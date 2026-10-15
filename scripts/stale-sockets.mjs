// The rules that decide which files the test runner (scripts/run-tests.mjs) may remove from the SDK's fixed socket folder when a
// run was stopped. They are kept apart so that a test can try each one with any file status, including one owned by another user.

/** Whether a name can be one of the pinned SDK's socket names: the SHA-256 of a path, in hexadecimal. */
export const sdkSocketName = name => /^[0-9a-f]{64}$/.test(name);

/** Whether a file's status (from `lstat`, so a link is not followed) is a socket made by this user: the only kind the runner removes. */
export const ownSocket = (info, uid) => info.isSocket() && info.uid === uid;

import { join, resolve } from 'node:path';

/** Synthetic-fixture launch only. Never use its mock encryption with a real profile or account. */
export function nativeTrialLaunch(task, copyApp, sourceEnv = process.env) {
  if (typeof task !== 'string' || resolve(task) !== task || !/^\/(?:private\/)?tmp\/claude-native-picker\.[A-Za-z0-9]+$/.test(task)) throw Error('Invalid native trial task root');
  const canonicalTask = task.replace(/^\/tmp\//, '/private/tmp/');
  if (copyApp !== join(canonicalTask, 'Claude Native Trial.app')) throw Error('Native trial launch must use its exact disposable app copy');
  const trial = join(task, 'trial');
  const env = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'SHELL', 'DISPLAY', '__CF_USER_TEXT_ENCODING']) {
    if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
  }
  env.TMPDIR = task;
  return {
    executable: join(copyApp, 'Contents/MacOS/Claude'),
    args: [`--user-data-dir=${join(trial, 'profile')}`, '--use-mock-keychain'],
    options: { env, cwd: join(trial, 'workspace'), stdio: ['ignore', 'ignore', 'ignore'] },
  };
}

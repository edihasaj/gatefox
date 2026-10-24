import { homedir } from "node:os";
import { isAbsolute } from "node:path";

type ObjectValue = Record<string, unknown>;

const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};

function homeRoots(value: unknown, home: string): unknown {
  if (!Array.isArray(value) || !value.some((entry) => entry === "~"))
    return value;
  return value.map((entry) => (entry === "~" ? home : entry));
}

/**
 * The desktop scheduler uses an exact `~` root sentinel after its thread start
 * has already resolved `cwd`. Gateway SDKs deserialize roots as absolute paths.
 * This preserves that explicit home permission without resolving any other path.
 */
export function translateGatewaySchedulerRoots(
  method: string,
  params: ObjectValue,
  home = homedir(),
): ObjectValue {
  if (
    (method !== "thread/start" && method !== "turn/start") ||
    !isAbsolute(home)
  ) {
    return params;
  }
  const runtimeWorkspaceRoots = homeRoots(params.runtimeWorkspaceRoots, home);
  const sandboxPolicy = object(params.sandboxPolicy);
  const writableRoots = homeRoots(sandboxPolicy.writableRoots, home);
  if (
    runtimeWorkspaceRoots === params.runtimeWorkspaceRoots &&
    writableRoots === sandboxPolicy.writableRoots
  ) {
    return params;
  }
  return {
    ...params,
    ...(runtimeWorkspaceRoots === params.runtimeWorkspaceRoots
      ? {}
      : { runtimeWorkspaceRoots }),
    ...(writableRoots === sandboxPolicy.writableRoots
      ? {}
      : { sandboxPolicy: { ...sandboxPolicy, writableRoots } }),
  };
}

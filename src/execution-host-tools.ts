import { createHash } from "node:crypto";
import { canonicalJson, type ExecutionDescriptor } from "./execution-host-engine.js";

/**
 * A gateway SDK without its adjacent Code Mode host cannot execute Code Mode
 * tools. Older desktop adapters can still send rows copied before that was
 * known, so the host makes the catalog executable before it assigns the
 * generation's persistent identity.
 */
const directToolsRevisionSalt = "harness-gateway/execution-direct-tools-v1";

/**
 * Returns the original descriptor when every row already uses direct tools.
 * Otherwise it only changes each catalog row's tool mode and derives a new
 * generation revision, keeping an old incompatible catalog out of a
 * generation directory with immutable identity metadata.
 */
export function normalizeExecutionTools(descriptor: ExecutionDescriptor, codeModeAvailable: boolean): ExecutionDescriptor {
  if (codeModeAvailable) return descriptor;
  let changed = false;
  const models = descriptor.catalog.models.map(model => {
    if (model.tool_mode === "direct") return model;
    changed = true;
    return { ...model, tool_mode: "direct" };
  });
  if (!changed) return descriptor;
  const catalog = { ...descriptor.catalog, models };
  const revision = createHash("sha256").update(canonicalJson({
    salt: directToolsRevisionSalt,
    originalRevision: descriptor.revision,
    normalForm: catalog,
  })).digest("hex");
  return { ...descriptor, revision, catalog };
}

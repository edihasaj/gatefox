import { access, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { writePrivateJson, type GatewayConfig } from "./config.js";
import { object, type Message } from "./app-server-connection.js";

export interface AgentPolicy { version: 1; coordinator: string; verifier: string; worker: string; effort: string }
export const agentProfileDirectory = (state: string, policy: AgentPolicy): string => resolve(state, "agent-profiles", createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 16));
const roles = {
  coordinator: { description: "Plan and coordinate delegated implementation work.", instructions: "Break the task into bounded work with clear file ownership and acceptance criteria. Delegate implementation to worker and independent checks to verifier. Review their results before reporting completion. Preserve repository instructions and the parent's permissions. Do not change accounts or providers." },
  verifier: { description: "Independently verify implementation and identify concrete defects.", instructions: "Review the assigned implementation against its acceptance criteria. Read the actual changes and run targeted checks when permitted. Report concrete defects with file locations and evidence. Do not implement unrelated changes or delegate further." },
  worker: { description: "Implement bounded coding tasks using the local workhorse model.", instructions: "Implement only the assigned task and files. Read repository instructions first, preserve others' changes, and verify the changed behavior. Report changed files, checks, and unresolved issues. Do not delegate further or claim success without evidence." },
};

export async function readAgentPolicy(state: string): Promise<AgentPolicy | undefined> {
  let value: unknown; try { value = JSON.parse(await readFile(resolve(state, "agent-policy.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Gateway agent policy is unreadable"); }
  const policy = object(value);
  if (policy.version !== 1 || [policy.coordinator, policy.verifier, policy.worker].some(value => typeof value !== "string" || !value) || !["low", "medium", "high", "xhigh"].includes(String(policy.effort))) throw new Error("Gateway agent policy is invalid");
  return policy as unknown as AgentPolicy;
}

export async function setupAgents(config: GatewayConfig, catalog: Message[], models: { coordinator?: string; verifier?: string; worker?: string }): Promise<Message> {
  for (const [role, model] of Object.entries(models)) {
    const row = catalog.find(row => row.slug === model);
    if (!row) throw new Error(`${role} must name an offered gateway model alias`);
    if (!(row.supported_reasoning_levels as Array<{ effort: string }>).some(level => level.effort === "high")) throw new Error(`${role} model does not offer high reasoning effort`);
  }
  if (!models.coordinator || !models.verifier || !models.worker) throw new Error("Agent setup requires --coordinator, --verifier, and --worker");
  const policy: AgentPolicy = { version: 1, coordinator: models.coordinator, verifier: models.verifier, worker: models.worker, effort: "high" };
  const directory = agentProfileDirectory(config.stateDirectory, policy); await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, role] of Object.entries(roles)) {
    const file = resolve(directory, name + ".toml");
    const contents = `# Managed by subscription-gateway agents\nname = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(role.description)}\nmodel = ${JSON.stringify(policy[name as keyof typeof roles])}\nmodel_reasoning_effort = "high"\ndeveloper_instructions = ${JSON.stringify(role.instructions)}\n`;
    try { const old = await readFile(file, "utf8"); if (old !== contents) throw new Error("Refusing to replace a changed versioned agent profile"); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await writeFile(file, contents, { mode: 0o600 });
  }
  await writePrivateJson(resolve(config.stateDirectory, "agent-policy.json"), policy);
  return { configured: true, scope: "gateway chats", policy, profiles: directory, primaryConfigUntouched: true };
}

export async function agentExecutorSettings(config: GatewayConfig, settings: Message): Promise<{ settings: Message; directory?: string }> {
  const policy = await readAgentPolicy(config.stateDirectory); if (!policy) return { settings };
  const directory = agentProfileDirectory(config.stateDirectory, policy); await access(directory);
  return { directory, settings: { ...settings, agents: { ...object(settings.agents), default_subagent_model: policy.worker, default_subagent_reasoning_effort: policy.effort } } };
}

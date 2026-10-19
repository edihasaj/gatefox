// Executable CI cost policy for .github/workflows/ci.yml.
//
// Every hosted job must be manual-only: a `workflow_dispatch` on
// `refs/heads/production` with the typed boolean `run_build` opt-in set to
// true, and the macOS job additionally gated on `run_native`. There are no
// push, pull_request, or schedule triggers. The scenarios below are inline on
// purpose so this guard never depends on an external fixture staying in sync.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/ci.yml");
const productionRef = "refs/heads/production";

function tokenize(expression) {
  const tokens = [];
  const token = /\s*(\&\&|\|\||==|\(|\)|true|false|'[^']*'|[a-z][a-z._]*)/y;
  let offset = 0;
  while (offset < expression.length) {
    token.lastIndex = offset;
    const match = token.exec(expression);
    assert.ok(match, `unsupported GitHub expression syntax near ${expression.slice(offset)}`);
    tokens.push(match[1]);
    offset = token.lastIndex;
  }
  return tokens;
}

function evaluateGithubExpression(expression, event) {
  const tokens = tokenize(expression);
  let index = 0;
  const value = () => {
    const current = tokens[index++];
    assert.ok(current, "unexpected end of GitHub expression");
    if (current === "true") return true;
    if (current === "false") return false;
    if (current.startsWith("'")) return current.slice(1, -1);
    const values = {
      "github.event_name": event.event_name ?? "",
      "github.ref": event.ref ?? "",
      "github.base_ref": event.base_ref ?? "",
      "inputs.run_build": event.inputs?.run_build ?? false,
      "inputs.run_native": event.inputs?.run_native ?? false,
    };
    assert.ok(current in values, `unknown GitHub context value: ${current}`);
    return values[current];
  };
  const primary = () => {
    if (tokens[index] === "(") {
      index += 1;
      const result = or();
      assert.equal(tokens[index++], ")", "unclosed GitHub expression group");
      return result;
    }
    const left = value();
    if (tokens[index] === "==") {
      index += 1;
      return left === value();
    }
    return Boolean(left);
  };
  const and = () => {
    let result = primary();
    while (tokens[index] === "&&") {
      index += 1;
      const right = primary();
      result = result && right;
    }
    return result;
  };
  const or = () => {
    let result = and();
    while (tokens[index] === "||") {
      index += 1;
      const right = and();
      result = result || right;
    }
    return result;
  };
  const result = or();
  assert.equal(index, tokens.length, `unparsed GitHub expression token: ${tokens[index]}`);
  return result;
}

function rootBlock(workflow, key) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  assert.notEqual(start, -1, `missing ${key} mapping`);
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith(" ") || lines[end] === "")) end += 1;
  return lines.slice(start + 1, end);
}

function nestedMappings(lines, indent) {
  const mappings = new Map();
  const mapping = new RegExp(`^ {${indent}}([A-Za-z_][A-Za-z0-9_-]*):(?:\\s*(.*))?$`);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(mapping);
    if (match) entries.push({ index, key: match[1], value: match[2] ?? "" });
  }
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    const next = entries[entryIndex + 1]?.index ?? lines.length;
    mappings.set(entry.key, { value: entry.value, lines: lines.slice(entry.index + 1, next) });
  }
  return mappings;
}

function yamlValue(value) {
  let quote;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && character === "\\") {
      index += 1;
      continue;
    }
    if (character === quote) {
      if (quote === "'" && value[index + 1] === "'") {
        index += 1;
      } else {
        quote = undefined;
      }
      continue;
    }
    if (!quote && (character === '"' || character === "'")) {
      quote = character;
      continue;
    }
    if (!quote && character === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trim();
}

function yamlScalar(value) {
  const trimmed = yamlValue(value);
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function yamlFlowList(value) {
  const trimmed = yamlValue(value);
  assert.ok(trimmed.startsWith("[") && trimmed.endsWith("]"), "expected a YAML flow list");
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => yamlScalar(item))
    .filter(Boolean);
}

function scalar(mapping, key, indent) {
  const child = nestedMappings(mapping.lines, indent).get(key);
  assert.ok(child, `missing ${key}`);
  assert.equal(child.lines.length, 0, `${key} must be a scalar`);
  return yamlValue(child.value);
}

function booleanScalar(mapping, key, indent) {
  const value = scalar(mapping, key, indent);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function runnerLabels(job) {
  const runner = nestedMappings(job.lines, 4).get("runs-on");
  assert.ok(runner, "missing runs-on");
  const value = yamlValue(runner.value);
  if (value.startsWith("[") && value.endsWith("]")) {
    assert.equal(runner.lines.length, 0, "runs-on flow list must not have child mappings");
    return yamlFlowList(value);
  }
  if (value === "") {
    const labels = runner.lines
      .filter((line) => line.startsWith("      - "))
      .map((line) => yamlScalar(line.trim().slice(2)));
    assert.ok(labels.length > 0, "runs-on list must include at least one label");
    return labels;
  }
  assert.equal(runner.lines.length, 0, "runs-on must be a scalar or YAML list");
  return [yamlScalar(value)];
}

function jobCondition(job, name) {
  const entry = nestedMappings(job.lines, 4).get("if");
  assert.ok(
    entry,
    `CI cost policy violation: ${name} has no explicit event/ref/run_build job gate`,
  );
  let block = yamlValue(entry.value);
  if (["", ">-", ">", "|-", "|", ">+", "|+"].includes(block)) {
    block = entry.lines.map((line) => line.trim()).filter(Boolean).join(" ");
  }
  const interpolation = block.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  assert.notEqual(
    interpolation,
    block,
    `CI cost policy violation: ${name} gate must use a GitHub expression`,
  );
  return interpolation.replace(/\s+/g, " ").trim();
}

function isNativeJob(job) {
  return runnerLabels(job).some((label) => label.startsWith("macos-"));
}

// Each scenario pairs a GitHub event context with what the policy allows:
// `hosted` for any CI job, `native` for a macOS runner job.
function costPolicyScenarios() {
  const everyOptIn = { run_build: true, run_native: true };
  const scenarios = [];
  for (const eventName of ["push", "pull_request", "schedule", "merge_group", "workflow_run"]) {
    for (const ref of [productionRef, "refs/heads/main", "refs/pull/9/merge", "refs/tags/v9.9.9"]) {
      scenarios.push({
        name: `automatic ${eventName} on ${ref} with every opt-in`,
        event_name: eventName,
        ref,
        base_ref: "production",
        inputs: everyOptIn,
        hosted: false,
        native: false,
      });
    }
  }
  const dispatchRefs = [
    ["production", productionRef],
    ["main", "refs/heads/main"],
    ["feature", "refs/heads/feat/ci-cost"],
    ["tag", "refs/tags/v9.9.9"],
  ];
  for (const [label, ref] of dispatchRefs) {
    const onProduction = ref === productionRef;
    scenarios.push({
      name: `dispatch on ${label} with run_build only`,
      event_name: "workflow_dispatch",
      ref,
      inputs: { run_build: true },
      hosted: onProduction,
      native: false,
    });
    scenarios.push({
      name: `dispatch on ${label} with both opt-ins`,
      event_name: "workflow_dispatch",
      ref,
      inputs: everyOptIn,
      hosted: onProduction,
      native: onProduction,
    });
  }
  scenarios.push({
    name: "dispatch on production with unresolved inputs",
    event_name: "workflow_dispatch",
    ref: productionRef,
    inputs: {},
    hosted: false,
    native: false,
  });
  scenarios.push({
    name: "dispatch on production with schema defaults",
    event_name: "workflow_dispatch",
    ref: productionRef,
    inputs: { run_build: false, run_native: false },
    hosted: false,
    native: false,
  });
  scenarios.push({
    name: "dispatch on production opting into native only",
    event_name: "workflow_dispatch",
    ref: productionRef,
    inputs: { run_build: false, run_native: true },
    hosted: false,
    native: false,
  });
  scenarios.push({
    name: "dispatch on production opting out of native",
    event_name: "workflow_dispatch",
    ref: productionRef,
    inputs: { run_build: true, run_native: false },
    hosted: true,
    native: false,
  });
  return scenarios;
}

function validateWorkflowPolicy(workflow) {
  const triggers = nestedMappings(rootBlock(workflow, "on"), 2);
  assert.deepEqual(
    [...triggers.keys()],
    ["workflow_dispatch"],
    "CI cost policy violation: workflow must be manual-only with no automatic triggers",
  );

  const dispatchInputs = nestedMappings(triggers.get("workflow_dispatch").lines, 4).get("inputs");
  assert.ok(dispatchInputs, "workflow_dispatch must define run_build and run_native inputs");
  for (const name of ["run_build", "run_native"]) {
    const input = nestedMappings(dispatchInputs.lines, 6).get(name);
    assert.ok(input, `workflow_dispatch must define a ${name} input`);
    assert.equal(scalar(input, "type", 8), "boolean", `${name} must be a typed boolean input`);
    assert.equal(booleanScalar(input, "required", 8), false, `${name} must remain optional`);
    assert.equal(booleanScalar(input, "default", 8), false, `${name} must default to false`);
  }

  const jobs = nestedMappings(rootBlock(workflow, "jobs"), 2);
  assert.ok(jobs.has("verify"), "CI must keep the Linux verify job");
  assert.ok(jobs.has("macos-native"), "CI must keep the macos-native job");
  const nativeJobs = [...jobs].filter(([, job]) => isNativeJob(job)).map(([name]) => name);
  assert.deepEqual(nativeJobs, ["macos-native"], "macos-native must be the only macOS job");

  const verifySteps = jobs.get("verify").lines.join("\n");
  for (const step of ["npm ci", "npm run build", "npm run check", "npm test"]) {
    assert.ok(verifySteps.includes(`- run: ${step}`), `verify must keep its ${step} step`);
  }

  const scenarios = costPolicyScenarios();
  for (const [name, job] of jobs) {
    const condition = jobCondition(job, name);
    const native = isNativeJob(job);
    for (const line of job.lines) {
      if (line.trim().startsWith("- uses:")) {
        assert.match(
          line,
          /- uses: [\w./-]+@[0-9a-f]{40} # /,
          `CI cost policy violation: ${name} must keep actions pinned to commit SHAs`,
        );
      }
    }
    for (const scenario of scenarios) {
      const expected = native ? scenario.native : scenario.hosted;
      assert.equal(
        evaluateGithubExpression(condition, scenario),
        expected,
        `CI cost policy violation: ${name} must ${expected ? "run" : "skip"} for ${scenario.name}`,
      );
    }
  }
  return jobs;
}

function removeJobCondition(workflow, name) {
  const lines = workflow.split("\n");
  const jobStart = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(jobStart, -1, `mutation target job ${name} is missing`);
  let jobEnd = jobStart + 1;
  while (jobEnd < lines.length && (lines[jobEnd].startsWith(" ") || lines[jobEnd] === "")) jobEnd += 1;
  const ifStart = lines.findIndex(
    (line, index) => index > jobStart && index < jobEnd && /^ {4}if:/.test(line),
  );
  assert.notEqual(ifStart, -1, `mutation target job ${name} has no gate to remove`);
  let ifEnd = ifStart + 1;
  while (ifEnd < jobEnd && (lines[ifEnd].startsWith("     ") || lines[ifEnd].trim() === "")) {
    ifEnd += 1;
  }
  return [...lines.slice(0, ifStart), ...lines.slice(ifEnd)].join("\n");
}

test("CI keeps every hosted job manual-only behind production run_build opt-ins", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const jobs = validateWorkflowPolicy(workflow);
  // Sanity: the documented positive opt-ins actually select both jobs.
  const productionOptIn = {
    event_name: "workflow_dispatch",
    ref: productionRef,
    inputs: { run_build: true, run_native: true },
  };
  assert.equal(evaluateGithubExpression(jobCondition(jobs.get("verify"), "verify"), productionOptIn), true);
  assert.equal(
    evaluateGithubExpression(jobCondition(jobs.get("macos-native"), "macos-native"), productionOptIn),
    true,
  );
});

test("CI cost policy rejects added automatic triggers", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.throws(
    () => validateWorkflowPolicy(workflow.replace("on:\n  workflow_dispatch:\n", "on:\n  push:\n    branches: [production]\n  workflow_dispatch:\n")),
    /manual-only with no automatic triggers/,
  );
  assert.throws(
    () => validateWorkflowPolicy(workflow.replace("on:\n  workflow_dispatch:\n", "on:\n  schedule:\n    - cron: '0 6 * * *'\n  workflow_dispatch:\n")),
    /manual-only with no automatic triggers/,
  );
  assert.throws(
    () => validateWorkflowPolicy(workflow.replace("on:\n  workflow_dispatch:\n", "on:\n  pull_request:\n  workflow_dispatch:\n")),
    /manual-only with no automatic triggers/,
  );
});

test("CI cost policy rejects ungated or under-gated jobs", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.throws(
    () => validateWorkflowPolicy(removeJobCondition(workflow, "verify")),
    /verify.*no explicit event\/ref\/run_build job gate/,
  );
  assert.throws(
    () => validateWorkflowPolicy(removeJobCondition(workflow, "macos-native")),
    /macos-native.*no explicit event\/ref\/run_build job gate/,
  );
  assert.throws(
    () => validateWorkflowPolicy(`${workflow}\n  extra-linux:\n    runs-on: ubuntu-24.04-arm\n    steps: []\n`),
    /extra-linux.*no explicit event\/ref\/run_build job gate/,
  );
  assert.throws(
    () =>
      validateWorkflowPolicy(
        `${workflow}\n  dispatch-only-linux:\n    if: \${{ github.event_name == 'workflow_dispatch' }}\n    runs-on: ubuntu-24.04-arm\n    steps: []\n`,
      ),
    /dispatch-only-linux must skip for dispatch on main with run_build only/,
  );
  assert.throws(
    () =>
      validateWorkflowPolicy(
        workflow.replace("inputs.run_build == true &&\n          inputs.run_native == true }}", "inputs.run_build == true }}"),
      ),
    /macos-native must skip for dispatch on production with run_build only/,
  );
  assert.throws(
    () =>
      validateWorkflowPolicy(
        `${workflow}\n  macos-extra:\n    if: >-\n      \${{ github.event_name == 'workflow_dispatch' &&\n          github.ref == 'refs/heads/production' &&\n          inputs.run_build == true &&\n          inputs.run_native == true }}\n    runs-on: macos-15\n    steps: []\n`,
      ),
    /only macOS job/,
  );
});

test("CI cost policy rejects weakened opt-in inputs", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.throws(
    () =>
      validateWorkflowPolicy(
        workflow.replace(/(run_build:\n(?:.*\n)*?        default: )false/, "$1true"),
      ),
    /run_build must default to false/,
  );
  assert.throws(
    () =>
      validateWorkflowPolicy(
        workflow.replace("      run_build:\n        description: Run hosted CI builds (paid)\n        required: false\n        default: false\n        type: boolean\n", ""),
      ),
    /must define a run_build input/,
  );
  assert.throws(
    () =>
      validateWorkflowPolicy(
        workflow.replace(
          /(run_native:\n(?:.*\n)*?        type: )boolean/,
          "$1string",
        ),
      ),
    /run_native must be a typed boolean input/,
  );
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/ci.yml");
const fixturePath = path.join(root, "scripts/tests/fixtures/ci-native-events.json");

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

function yamlList(mapping, key, indent) {
  const child = nestedMappings(mapping.lines, indent).get(key);
  if (!child) return undefined;
  const value = yamlValue(child.value);
  if (value.startsWith("[") && value.endsWith("]")) {
    return yamlFlowList(value);
  }
  assert.equal(value, "", `${key} must use a YAML list`);
  return child.lines
    .filter((line) => line.startsWith(" ".repeat(indent + 2) + "- "))
    .map((line) => yamlScalar(line.trim().slice(2)));
}

function scalar(mapping, key, indent) {
  const child = nestedMappings(mapping.lines, indent).get(key);
  assert.ok(child, `missing ${key}`);
  assert.equal(child.lines.length, 0, `${key} must be a scalar`);
  return child.value;
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

function nativeCondition(job) {
  const start = job.lines.findIndex((line) => line === "    if: >-");
  assert.notEqual(start, -1, "macos-native must have a folded job condition");
  const expressionLines = [];
  for (const line of job.lines.slice(start + 1)) {
    if (!line.startsWith("      ")) break;
    expressionLines.push(line);
  }
  const block = expressionLines.join("\n").trim();
  const interpolation = block.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  assert.notEqual(interpolation, block, "macos-native condition must use a GitHub expression");
  return interpolation.replace(/\s+/g, " ");
}

function branchPatternMatches(branch, pattern) {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`).test(branch);
}

function branchAllowed(branch, included, ignored) {
  const includedByBranchFilter =
    included === undefined || included.some((pattern) => branchPatternMatches(branch, pattern));
  const excludedByBranchFilter = ignored?.some((pattern) => branchPatternMatches(branch, pattern)) ?? false;
  return includedByBranchFilter && !excludedByBranchFilter;
}

function triggerAllows(trigger, event) {
  if (!trigger) return false;
  if (event.event_name === "push") {
    const branch = event.ref?.replace(/^refs\/heads\//, "");
    const branches = yamlList(trigger, "branches", 4);
    const ignoredBranches = yamlList(trigger, "branches-ignore", 4);
    return Boolean(branch) && branchAllowed(branch, branches, ignoredBranches);
  }
  if (event.event_name === "pull_request") {
    const branches = yamlList(trigger, "branches", 4);
    const ignoredBranches = yamlList(trigger, "branches-ignore", 4);
    return branchAllowed(event.base_ref ?? "", branches, ignoredBranches);
  }
  return event.event_name === "workflow_dispatch";
}

function validateWorkflowPolicy(workflow) {
  const triggers = nestedMappings(rootBlock(workflow, "on"), 2);
  assert.deepEqual(
    [...triggers.keys()].sort(),
    ["pull_request", "push", "workflow_dispatch"],
    "CI must not add automatic event triggers outside push and pull_request",
  );
  assert.deepEqual(
    yamlList(triggers.get("push"), "branches", 4)?.sort(),
    ["main", "production"],
    "push CI must cover main and production only",
  );

  assert.ok(
    triggerAllows(triggers.get("pull_request"), {
      event_name: "pull_request",
      base_ref: "production",
    }),
    "pull_request trigger must route production pull requests",
  );

  const dispatchInputs = nestedMappings(triggers.get("workflow_dispatch").lines, 4).get("inputs");
  assert.ok(dispatchInputs, "workflow_dispatch must define inputs");
  const runNative = nestedMappings(dispatchInputs.lines, 6).get("run_native");
  assert.ok(runNative, "workflow_dispatch must define run_native");
  assert.equal(booleanScalar(runNative, "required", 8), false, "run_native must remain optional");
  assert.equal(booleanScalar(runNative, "default", 8), false, "run_native must default to false");
  assert.equal(booleanScalar(runNative, "type", 8), "boolean", "run_native must be a boolean input");

  const jobs = nestedMappings(rootBlock(workflow, "jobs"), 2);
  const macosJobs = [...jobs].filter(([, job]) => runnerLabels(job).some((label) => label.startsWith("macos-")));
  assert.deepEqual(
    macosJobs.map(([name]) => name),
    ["macos-native"],
    "macos-native must be the only macOS job",
  );
  const condition = nativeCondition(jobs.get("macos-native"));

  return { condition, triggers };
}

test("CI keeps macOS checks production/manual and leaves Linux CI automatic", async () => {
  const [workflow, fixtures] = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(fixturePath, "utf8").then(JSON.parse),
  ]);
  const { condition, triggers } = validateWorkflowPolicy(workflow);

  for (const fixture of fixtures) {
    assert.equal(
      evaluateGithubExpression(condition, fixture),
      fixture.expected,
      `${fixture.name} must ${fixture.expected ? "run" : "skip"} macOS checks`,
    );
    if (fixture.expected) {
      assert.ok(triggerAllows(triggers.get(fixture.event_name), fixture), `${fixture.name} must start CI`);
    }
  }
});

test("CI native policy rejects unapproved triggers and macOS jobs", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.throws(
    () => validateWorkflowPolicy(workflow.replace("permissions:\n", "  workflow_run:\n    workflows: [CI]\npermissions:\n")),
    /automatic event triggers/,
  );
  assert.throws(
    () => validateWorkflowPolicy(workflow.replace("  pull_request:\n", "  pull_request:\n    branches: [main]\n")),
    /production pull requests/,
  );
  assert.throws(
    () => validateWorkflowPolicy(`${workflow}\n  macos-unconditional:\n    runs-on: macos-15\n    steps: []\n`),
    /only macOS job/,
  );
  assert.throws(
    () => validateWorkflowPolicy(`${workflow}\n  macos-quoted:\n    runs-on: \"macos-15\"\n    steps: []\n`),
    /only macOS job/,
  );
  assert.throws(
    () =>
      validateWorkflowPolicy(
        `${workflow}\n  macos-inline-comment:\n    runs-on: \"macos-15\" # native runner\n    steps: []\n`,
      ),
    /only macOS job/,
  );
  assert.throws(
    () => validateWorkflowPolicy(`${workflow}\n  macos-array:\n    runs-on: [macos-15]\n    steps: []\n`),
    /only macOS job/,
  );
  assert.throws(
    () => validateWorkflowPolicy(workflow.replace("  pull_request:\n", "  pull_request:\n    branches-ignore: [production]\n")),
    /production pull requests/,
  );
});

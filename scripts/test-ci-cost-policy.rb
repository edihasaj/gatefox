#!/usr/bin/env ruby
# frozen_string_literal: true
#
# CI cost policy guard. Parses the actual workflow YAML and proves every
# hosted job (Linux and macOS alike) is manual-only: a workflow_dispatch on
# refs/heads/production with the typed boolean run_build opt-in, macOS jobs
# additionally requiring run_native. No push, pull_request, or schedule
# triggers may exist, and no job may run by default.

require "yaml"
require "open3"
require "tmpdir"
require "fileutils"

ROOT = File.expand_path("..", __dir__)
remote, status = Open3.capture2("git", "-C", ROOT, "config", "--get", "remote.origin.url")
raise "repository identity unavailable" unless status.success?
REPOSITORY = remote.strip[/github\.com[:\/]([^\/]+\/[^\/]+?)(?:\.git)?$/, 1]
raise "repository identity invalid" unless REPOSITORY

def condition(expression, context)
  source = (expression || "true").strip.sub(/\A\$\{\{\s*/, "").sub(/\s*\}\}\z/, "")
  source = source.gsub(/\b(?:github|inputs|needs|matrix)(?:\.[A-Za-z0-9_-]+)+/) do |reference|
    parts = reference.split(".")
    value = parts.reduce(context) { |item, key| item.is_a?(Hash) ? item[key] : nil }
    value = "success" if parts.first == "needs" && parts.last == "result"
    value.inspect
  end
  source = source.gsub(/\b(always|success)\(\)/, "true").gsub(/\b(cancelled|failure)\(\)/, "false")
  tokens = source.scan(/\s+|'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|\b(?:true|false|nil|startsWith)\b|==|!=|&&|\|\||!|\(|\)|,/ )
  raise "unsupported cost guard #{expression.inspect}" unless tokens.join == source
  !!eval(source)
end

def startsWith(value, prefix)
  value.to_s.start_with?(prefix)
end

def context_for(event, ref, inputs)
  {
    "github" => {
      "repository" => REPOSITORY, "event_name" => event, "ref" => ref,
      "ref_name" => ref.split("/").last, "base_ref" => "production", "actor" => "owner",
      "ref_protected" => true, "event" => { "inputs" => inputs },
    },
    "inputs" => inputs,
    "needs" => {},
  }
end

def triggers_of(document)
  triggers = document[true] || document["on"] || {}
  raise "workflow must be manual-only with a single workflow_dispatch trigger" unless triggers.is_a?(Hash) && triggers.keys.map(&:to_s).sort == ["workflow_dispatch"]
  triggers
end

def dispatch_inputs(triggers)
  schema = triggers.is_a?(Hash) ? triggers.dig("workflow_dispatch", "inputs") : nil
  schema.is_a?(Hash) ? schema : {}
end

# Scenario matrix applied to every hosted job. `hosted`/`native` say whether
# the job is allowed to consume runner minutes for that event context.
def cost_scenarios(production_ref)
  refs = [production_ref, "refs/heads/main", "refs/heads/feature/ci", "refs/pull/1/merge", "refs/tags/v9.9.9"]
  scenarios = %w[push pull_request schedule merge_group workflow_run release workflow_call].product(refs).map do |event, ref|
    [{ "event_name" => event, "ref" => ref }, false, false, "automatic #{event} on #{ref} with every opt-in"]
  end
  [production_ref, "refs/heads/main", "refs/heads/feature/ci", "refs/tags/v9.9.9"].each do |ref|
    on_production = ref == production_ref
    scenarios << [{ "event_name" => "workflow_dispatch", "ref" => ref }, on_production, false, "dispatch on #{ref} with run_build only"]
    scenarios << [{ "event_name" => "workflow_dispatch", "ref" => ref }, on_production, on_production, "dispatch on #{ref} with both opt-ins"]
  end
  scenarios << [{ "event_name" => "workflow_dispatch", "ref" => production_ref }, false, false, "dispatch on production without opt-ins"]
  scenarios
end

def check_workflow(document, label, production_ref = "refs/heads/production")
  triggers = triggers_of(document)
  schema = dispatch_inputs(triggers)
  run_build = schema["run_build"]
  raise "#{label} must define a run_build boolean input" unless run_build.is_a?(Hash) && run_build["type"] == "boolean" && run_build["required"] == false
  raise "#{label} run_build must default to false" unless run_build["default"] == false
  defaults = schema.transform_values { |input| input["default"] }
  hosted = 0
  native = 0
  document.fetch("jobs", {}).each do |name, job|
    hosted += 1
    labels = [job["runs-on"], job.dig("strategy", "matrix")].join(" ")
    is_native = labels.match?(/macos|xcode/i)
    native += 1 if is_native
    raise "#{label}/#{name} has no explicit event/ref/run_build job gate" if job["if"].nil?
    build_on = defaults.merge("run_build" => true)
    all_on = defaults.merge("run_build" => true, "run_native" => true, "native_diagnostics" => true, "publish" => true, "platform" => "all", "preflight_only" => false)
    cost_scenarios(production_ref).each do |github, hosted_ok, native_ok, scenario|
      inputs = is_native || !scenario.include?("run_build only") ? all_on : build_on
      inputs = {} if scenario.include?("without opt-ins")
      inputs = build_on if scenario.include?("run_build only")
      allowed = is_native ? native_ok : hosted_ok
      ran = condition(job["if"], context_for(github["event_name"], github["ref"], inputs))
      raise "#{label}/#{name} must #{allowed ? "run" : "skip"} for #{scenario}" if ran != allowed
    end
    production = context_for("workflow_dispatch", production_ref, all_on)
    raise "#{label}/#{name} lost its explicit production path" unless condition(job["if"], production)
    if is_native
      raise "#{label}/#{name} allocates a Mac without the run_native opt-in" if condition(job["if"], context_for("workflow_dispatch", production_ref, build_on))
    end
    raise "#{label}/#{name} allocates a Mac by default" if condition(job["if"], context_for("workflow_dispatch", production_ref, defaults))
  end
  [hosted, native]
end

def deep_copy(object)
  Marshal.load(Marshal.dump(object))
end

def assert_rejects(label)
  yield
  raise "mutation escaped the cost policy: #{label}"
rescue RuntimeError => error
  raise error if error.message.start_with?("mutation escaped")
end

hosted_total = 0
native_total = 0
Dir.glob(File.join(ROOT, ".github/workflows/*.{yml,yaml}")).each do |path|
  document = YAML.safe_load(File.read(path), aliases: true)
  next unless document.is_a?(Hash)
  hosted, native = check_workflow(document, File.basename(path))
  hosted_total += hosted
  native_total += native

  # Mutation coverage: the same checks must reject realistic regressions.
  ungated = deep_copy(document)
  ungated_job = ungated.fetch("jobs").values.first
  ungated_job.delete("if")
  assert_rejects("#{File.basename(path)} with an ungated job") { check_workflow(ungated, "mutation:ungated") }

  extra = deep_copy(document)
  extra["jobs"]["extra-linux"] = { "runs-on" => "ubuntu-latest", "steps" => [{ "run" => "npm test" }] }
  assert_rejects("#{File.basename(path)} with a new ungated job") { check_workflow(extra, "mutation:extra-job") }

  triggered = deep_copy(document)
  key = triggered.key?(true) ? true : "on"
  triggered[key] = { "workflow_dispatch" => triggered[key] } unless triggered[key].is_a?(Hash)
  triggered[key]["push"] = { "branches" => ["production"] }
  assert_rejects("#{File.basename(path)} with a push trigger") { check_workflow(triggered, "mutation:push") }

  scheduled = deep_copy(document)
  skey = scheduled.key?(true) ? true : "on"
  scheduled[skey] = { "workflow_dispatch" => scheduled[skey] } unless scheduled[skey].is_a?(Hash)
  scheduled[skey]["schedule"] = [{ "cron" => "0 6 * * *" }]
  assert_rejects("#{File.basename(path)} with a schedule") { check_workflow(scheduled, "mutation:schedule") }

  opted = deep_copy(document)
  build = dispatch_inputs(triggers_of(opted))["run_build"]
  build["default"] = true
  assert_rejects("#{File.basename(path)} with run_build defaulting to true") { check_workflow(opted, "mutation:default-true") }

  weakened = deep_copy(document)
  weakened["jobs"][weakened["jobs"].keys.first]["if"] = "${{ github.event_name == 'workflow_dispatch' }}"
  assert_rejects("#{File.basename(path)} with a dispatch-only job gate") { check_workflow(weakened, "mutation:dispatch-only") }

  linux = deep_copy(document)
  native_key = linux["jobs"].find { |_, job| [job["runs-on"]].join(" ").match?(/macos|xcode/i) }&.first
  if native_key
    linux["jobs"][native_key]["if"] = linux["jobs"][weakened["jobs"].keys.first]["if"]
    assert_rejects("#{File.basename(path)} losing the native opt-in") { check_workflow(linux, "mutation:lose-native-opt-in") }
  end
end

# Linux jobs must stay gated too: drop every gate and re-check.
Dir.glob(File.join(ROOT, ".github/workflows/*.{yml,yaml}")).each do |path|
  document = YAML.safe_load(File.read(path), aliases: true)
  next unless document.is_a?(Hash) && document["jobs"].is_a?(Hash)
  linux = document["jobs"].reject { |_, job| [job["runs-on"], job.dig("strategy", "matrix")].join(" ").match?(/macos|xcode/i) }
  next if linux.empty?
  stripped = deep_copy(document)
  stripped["jobs"] = linux.transform_values { |job| job.reject { |key, _| key == "if" } }
  assert_rejects("#{File.basename(path)} with ungated Linux jobs") { check_workflow(stripped, "mutation:ungated-linux") }
end

validator = File.join(ROOT, "scripts/validate-production-release.sh")
if File.file?(validator)
  Dir.mktmpdir("production-release-contract-") do |dir|
    git = ->(*args) { output, result = Open3.capture2e("git", "-C", dir, *args); raise output unless result.success?; output.strip }
    git.call("init", "-q"); git.call("config", "user.email", "test@example.invalid"); git.call("config", "user.name", "Policy Test")
    git.call("commit", "--allow-empty", "-qm", "production")
    sha = git.call("rev-parse", "HEAD"); git.call("update-ref", "refs/remotes/origin/production", sha); git.call("tag", "-a", "v1.2.3", "-m", "production")
    check = ->(tag, ref, revision) { Open3.capture2e({"RELEASE_TAG" => tag, "GITHUB_REF" => ref, "GITHUB_SHA" => revision, "GITHUB_OUTPUT" => File.join(dir, "outputs")}, "bash", validator, chdir: dir).last.success? }
    raise "exact production tag rejected" unless check.call("v1.2.3", "refs/heads/production", sha)
    [["v1.2.3", "refs/heads/main", sha], ["v9.9.9", "refs/heads/production", sha], ["$(touch injected)", "refs/heads/production", sha], ["v1.2.3", "refs/heads/production", "0" * 40]].each do |arguments|
      raise "invalid release identity accepted" if check.call(*arguments)
    end
    git.call("commit", "--allow-empty", "-qm", "next"); git.call("update-ref", "refs/remotes/origin/production", git.call("rev-parse", "HEAD"))
    raise "stale production tag accepted" if check.call("v1.2.3", "refs/heads/production", sha)
  end
end

puts "CI cost policy passed: #{hosted_total} hosted jobs (#{native_total} native), manual-only production/run_build opt-ins, no automatic or default allocation; production identity checked."

if REPOSITORY == "edihasaj/vmlab"
  document = YAML.safe_load(File.read(File.join(ROOT, ".github/workflows/release.yml")), aliases: true)
  raise "VMLab cross-builds must stay on Linux" unless document.dig("jobs", "goreleaser", "runs-on") == "ubuntu-24.04"
  raise "VMLab release must be manual-only" unless document.fetch(true).keys == ["workflow_dispatch"]
end
if REPOSITORY == "edihasaj/foretype"
  document = YAML.safe_load(File.read(File.join(ROOT, ".github/workflows/release.yml")), aliases: true)
  raise "Foretype upload must stay on Linux" unless document.dig("jobs", "publish", "runs-on") == "ubuntu-24.04"
  raise "Foretype upload must retain approval" unless document.dig("jobs", "publish", "environment") == "production"
end

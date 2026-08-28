import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

test("DSH native tools all publish object JSON schemas", async () => {
  const registered = [];
  const directory = await mkdtemp(join(tmpdir(), "dsh-sdr-index-"));
  const context = {
    tools: {
      register(definition) {
        registered.push(definition);
        return () => undefined;
      },
      guard() {
        return () => undefined;
      },
    },
    userQuestions: { ask: async () => ({ answers: [] }) },
  };
  const dispose = await apply(context, { role: "agent", dataFile: join(directory, "state.json") });
  assert.deepEqual(registered.map((item) => item.name), [
    "sdr_create_task",
    "sdr_knowledge_search",
    "sdr_knowledge_upsert",
    "sdr_knowledge_list",
    "sdr_knowledge_evaluate",
    "sdr_next_step",
    "sdr_review_drafts",
    "sdr_continue_after_approval",
    "sdr_get_task",
    "sdr_get_report",
    "sdr_audit_log",
    "sdr_connector_status",
    "sdr_configure_connector",
  ]);
  for (const item of registered) {
    assert.equal(item.parameters.type, "object", item.name);
    assert.equal(item.output.schema.type, "object", item.name);
  }
  dispose();
});

test("bundle and SDR preset point at the published scoped package", async () => {
  const patch = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  const preset = await readFile(new URL("../presets/sdr/agent.cordis.yml", import.meta.url), "utf8");
  assert.match(patch, /name:\s*['"]@xuxchloris\/dsh-sdr['"]/);
  assert.doesNotMatch(patch, /name:\s*['"]dsh-sdr['"]/);
  assert.match(preset, /name:\s*['"]@xuxchloris\/dsh-sdr['"]/);
  assert.doesNotMatch(preset, /name:\s*['"]dsh-sdr['"]/);
});

test("审批询问透传 agent-owned 执行身份", async () => {
  const registered = [];
  let asked;
  const directory = await mkdtemp(join(tmpdir(), "dsh-sdr-approval-"));
  const context = {
    tools: {
      register(definition) {
        registered.push(definition);
        return () => undefined;
      },
      guard() {
        return () => undefined;
      },
    },
    userQuestions: {
      ask: async (request) => {
        asked = request;
        return { answers: [{ id: "drafts", selected: [] }] };
      },
    },
  };
  const dispose = await apply(context, { role: "agent", dataFile: join(directory, "state.json") });
  const create = registered.find((item) => item.name === "sdr_create_task");
  const next = registered.find((item) => item.name === "sdr_next_step");
  const review = registered.find((item) => item.name === "sdr_review_drafts");
  const created = await create.execute({ task: "开发 1 个美国客户", campaign_version: "agent-owned" });
  for (let index = 0; index < 5; index += 1) await next.execute({ task_id: created.task_id });
  await review.execute({ task_id: created.task_id }, { agent: { id: "agent-test" }, signal: new AbortController().signal });
  assert.deepEqual(asked.agent, { id: "agent-test" });
  dispose();
});

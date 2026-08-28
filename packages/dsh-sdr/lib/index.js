import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { ConnectorRegistry, JsonStore, SdrService, defaultStorePath } from "./domain.js";

const PACKAGE_NAME = "dsh-sdr";
const PACKAGE_MANIFEST = createRequire(import.meta.url)("../package.json");
const VERSION = PACKAGE_MANIFEST.version;
const SOURCE_PRESET = fileURLToPath(new URL("../presets/sdr/", import.meta.url));

function dshHome() {
  return process.env.DSH_HOME || join(os.homedir(), ".dsh");
}

function targetPreset(presetId = "sdr") {
  return join(dshHome(), ".agent-presets", presetId);
}

async function readManagedMarker(path) {
  try {
    return JSON.parse(await readFile(join(path, ".dsh-sdr-managed.json"), "utf8"));
  } catch {
    return undefined;
  }
}

async function installManagedPreset() {
  const destination = targetPreset();
  const existing = await readManagedMarker(destination);
  let destinationExists = false;
  try {
    await stat(destination);
    destinationExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (destinationExists && (!existing || existing.package !== PACKAGE_NAME)) {
    throw new Error(`dsh-sdr: refusing to overwrite an unmanaged preset at ${destination}`);
  }
  try {
    await mkdir(destination, { recursive: true });
    await copyFile(join(SOURCE_PRESET, "agent.cordis.yml"), join(destination, "agent.cordis.yml"));
    await copyFile(join(SOURCE_PRESET, "preset.yml"), join(destination, "preset.yml"));
    await writeFile(join(destination, ".dsh-sdr-managed.json"), `${JSON.stringify({ managedBy: PACKAGE_NAME, package: PACKAGE_NAME, version: VERSION }, null, 2)}\n`, "utf8");
    return destination;
  } catch (error) {
    throw new Error(`dsh-sdr: cannot install managed preset at ${destination}: ${String(error)}`, { cause: error });
  }
}

const objectOutput = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
};

const schemas = {
  createTask: {
    type: "object",
    additionalProperties: false,
    properties: {
      task: { type: "string", description: "例如：开发 3 个美国户外用品客户" },
      market: { type: "string", description: "可选市场代码，如 US、EU、SEA、JP" },
      product: { type: "string", description: "可选产品名称" },
      campaign_version: { type: "string", description: "可选活动版本，用于幂等去重" },
    },
    required: ["task"],
  },
  taskId: {
    type: "object",
    additionalProperties: false,
    properties: { task_id: { type: "string", description: "SDR 任务 ID" } },
    required: ["task_id"],
  },
  connectorConfig: {
    type: "object",
    additionalProperties: false,
    properties: {
      channel: { type: "string", enum: ["email", "whatsapp", "crm"], description: "要配置的 connector" },
      settings: { type: "object", additionalProperties: true, description: "非敏感连接参数和凭证引用名；不能填写密码或 API key 值" },
    },
    required: ["channel", "settings"],
  },
  knowledgeSearch: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "要检索的产品、品牌、市场或规则关键词" },
      types: { type: "array", items: { type: "string", enum: ["product", "brand", "policy", "case", "market", "company"] } },
      limit: { type: "integer", description: "可选结果数，范围 1-20" },
    },
    required: ["query"],
  },
  knowledgeUpsert: {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["product", "brand", "policy", "case", "market", "company"] },
      title: { type: "string", description: "知识条目标题" },
      content: { type: "string", description: "已由用户确认的企业知识内容，不要写入密码或 API key" },
      tags: { type: "array", items: { type: "string" } },
      source: { type: "string", description: "来源，例如 user-guided、catalogue.pdf、crm" },
    },
    required: ["type", "title", "content", "source"],
  },
  knowledgeList: {
    type: "object",
    additionalProperties: false,
    properties: { type: { type: "string", enum: ["product", "brand", "policy", "case", "market", "company"] } },
  },
  knowledgeEvaluate: {
    type: "object",
    additionalProperties: false,
    properties: {
      k: { type: "integer", description: "评测前 K 个结果，范围 1-20" },
      queries: {
        type: "array",
        description: "至少 1 条、最多 100 条带标准答案的查询",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            types: { type: "array", items: { type: "string", enum: ["product", "brand", "policy", "case", "market", "company"] } },
            relevant_knowledge_ids: { type: "array", items: { type: "string" } },
          },
          required: ["text", "relevant_knowledge_ids"],
        },
      },
    },
    required: ["queries"],
  },
};

function assertIntegerRange(value, name, minimum, maximum) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum}-${maximum} 的整数`);
  }
}

function validateKnowledgeSearchArgs(args) {
  assertIntegerRange(args.limit, "limit", 1, 20);
}

function validateKnowledgeEvaluateArgs(args) {
  assertIntegerRange(args.k, "k", 1, 20);
  if (!Array.isArray(args.queries) || args.queries.length < 1 || args.queries.length > 100) {
    throw new Error("queries 必须包含 1-100 条查询");
  }
}

function deploymentConfigFromEnv() {
  const raw = process.env.DSH_SDR_DEPLOYMENT_CONFIG_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`DSH_SDR_DEPLOYMENT_CONFIG_JSON 不是合法 JSON: ${String(error.message || error)}`);
  }
}

function registerTool(ctx, definition) {
  return ctx.tools.register({ ...definition, output: objectOutput });
}

function registerNativeSdr(ctx, config = {}) {
  const service = new SdrService({
    store: new JsonStore(config.dataFile || defaultStorePath()),
    connectors: new ConnectorRegistry(),
    knowledge: config.knowledge,
    deploymentConfig: config.deploymentConfig || deploymentConfigFromEnv(),
    allowAgentConfig: config.allowAgentConfig === true || process.env.DSH_SDR_AGENT_CONFIG === "1",
    allowAgentLiveConfig: config.allowAgentLiveConfig === true || process.env.DSH_SDR_AGENT_LIVE_CONFIG === "1",
    allowAgentKnowledge: config.allowAgentKnowledge === true || process.env.DSH_SDR_AGENT_KNOWLEDGE === "1",
  });

  const disposers = [];
  disposers.push(registerTool(ctx, {
    name: "sdr_create_task",
    description: "创建一个可恢复的 SDR 任务。相同请求、市场、产品和活动版本会幂等复用，不会重复开发同一活动。",
    parameters: schemas.createTask,
    async execute(args) {
      try {
        return await service.createTask({ task: args.task, market: args.market, product: args.product, campaignVersion: args.campaign_version });
      } catch (error) {
        return { error: String(error.message || error) };
      }
    },
  }));

  disposers.push(registerTool(ctx, {
    name: "sdr_knowledge_search",
    description: "检索已批准的企业知识库。任务流程会自动检索产品、品牌、政策、案例和市场资料，并在草稿/结案中记录引用。",
    parameters: schemas.knowledgeSearch,
    async execute(args) {
      try {
        validateKnowledgeSearchArgs(args);
        return await service.knowledgeSearch(args.query, { types: args.types, limit: args.limit });
      } catch (error) {
        return { error: String(error.message || error) };
      }
    },
  }));

  disposers.push(registerTool(ctx, {
    name: "sdr_knowledge_upsert",
    description: "在部署策略显式开启 DSH_SDR_AGENT_KNOWLEDGE=1 后，将用户引导确认的产品、品牌、规则、案例或市场信息持久化。内容带来源、版本和审计；凭证内容会被拒绝。",
    parameters: schemas.knowledgeUpsert,
    async execute(args) {
      try {
        return await service.knowledgeUpsert(args);
      } catch (error) {
        return { error: String(error.message || error) };
      }
    },
  }));

  disposers.push(registerTool(ctx, {
    name: "sdr_knowledge_list",
    description: "列出持久化企业知识条目摘要。",
    parameters: schemas.knowledgeList,
    async execute(args) {
      try {
        return await service.knowledgeList(args);
      } catch (error) {
        return { error: String(error.message || error) };
      }
    },
  }));

  disposers.push(registerTool(ctx, {
    name: "sdr_knowledge_evaluate",
    description: "用带有标准答案的查询集评测知识库召回质量，返回 Recall@K 和 MRR；用于上线前回归，不修改业务状态。",
    parameters: schemas.knowledgeEvaluate,
    async execute(args) {
      try {
        validateKnowledgeEvaluateArgs(args);
        return await service.knowledgeEvaluate(args);
      } catch (error) {
        return { error: String(error.message || error) };
      }
    },
  }));

  disposers.push(registerTool(ctx, {
    name: "sdr_next_step",
    description: "执行当前任务的下一个 SOP 阶段。阶段由服务端状态机决定，模型不能指定或跳过阶段。到人工审批阶段会结构化阻断。",
    parameters: schemas.taskId,
    async execute(args) {
      try {
        return await service.nextStep(args.task_id);
      } catch (error) {
        return { error: String(error.message || error) };
      }
    },
  }));

  disposers.push(registerTool(ctx, {
    name: "sdr_review_drafts",
    description: "在人工审批卡点展示全部开发信草稿，并等待人类选择。此工具是唯一的审批入口，不向模型暴露 approve 或 send 工具。",
    parameters: schemas.taskId,
    async execute(args, exec) {
      try {
        const pending = await service.getDrafts(args.task_id);
        if (!pending.drafts.length) return pending;
        const options = pending.drafts.map((draft) => ({ label: draft.email_id, description: `${draft.company}: ${draft.subject}` }));
        const detail = pending.drafts.map((draft) => `【${draft.email_id}】${draft.company}\n${draft.subject}\n${draft.body}`).join("\n\n");
        const answer = await ctx.userQuestions.ask({
          questions: [{ id: "drafts", header: "SDR 开发信审批", question: "选择允许进入下一阶段的开发信；未选择的草稿会继续保持待审批。", detail, options, multiSelect: true }],
          ...(exec?.agent !== undefined ? { agent: exec.agent } : {}),
          signal: exec?.signal,
        });
        const selected = answer?.answers?.find((item) => item.id === "drafts")?.selected || [];
        return await service.reviewDrafts(args.task_id, selected, "dsh-user");
      } catch (error) {
        return { error: String(error.message || error) };
      }
    },
  }));

  disposers.push(registerTool(ctx, {
    name: "sdr_continue_after_approval",
    description: "审批卡点后的结构化放行。只有每一封草稿都有当前哈希绑定的人工批准凭证时，才允许进入跟进阶段。",
    parameters: schemas.taskId,
    async execute(args) {
      try {
        return await service.continueAfterApproval(args.task_id);
      } catch (error) {
        return { error: String(error.message || error) };
      }
    },
  }));

  disposers.push(registerTool(ctx, {
    name: "sdr_get_task",
    description: "读取 SDR 任务的真实持久化状态摘要。",
    parameters: schemas.taskId,
    async execute(args) {
      try {
        return await service.getTask(args.task_id);
      } catch (error) {
        return { error: String(error.message || error) };
      }
    },
  }));

  disposers.push(registerTool(ctx, {
    name: "sdr_get_report",
    description: "读取结构化结案报告；任务未到结案阶段时会明确返回 incomplete。",
    parameters: schemas.taskId,
    async execute(args) {
      try {
        return await service.getReport(args.task_id);
      } catch (error) {
        return { error: String(error.message || error) };
      }
    },
  }));

  disposers.push(registerTool(ctx, {
    name: "sdr_audit_log",
    description: "读取 SDR 任务的完整事件审计日志，用于回放和结案核验。",
    parameters: schemas.taskId,
    async execute(args) {
      try {
        return await service.auditLog(args.task_id);
      } catch (error) {
        return { error: String(error.message || error) };
      }
    },
  }));

  disposers.push(registerTool(ctx, {
    name: "sdr_connector_status",
    description: "查看 Email、WhatsApp、CRM connector 的注册状态、部署基线和 Agent 运行时覆盖；敏感值不会返回。",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() {
      return service.connectorStatus();
    },
  }));

  disposers.push(registerTool(ctx, {
    name: "sdr_configure_connector",
    description: "在部署策略显式放行时配置 connector 的非敏感参数。部署配置保留为基线；Agent 只能写入白名单字段或凭证引用名，不能写入密码、token、API key 值。",
    parameters: schemas.connectorConfig,
    async execute(args) {
      try {
        return await service.configureConnector({ channel: args.channel, settings: args.settings, actor: "sdr-agent" });
      } catch (error) {
        return { error: String(error.message || error) };
      }
    },
  }));

  const disposeGuard = ctx.tools.guard((execution) => {
    const name = String(execution.name || "").toLowerCase();
    if (name.includes("approve") || name.includes("send_email") || name.includes("send-email") || name === "send") {
      return "SDR 审批和发送只能由原生人工审批门控完成；模型不能直接批准或发送消息。";
    }
    return undefined;
  });
  disposers.push(disposeGuard);
  return () => disposers.splice(0).reverse().forEach((dispose) => dispose?.());
}

export async function apply(ctx, config = {}) {
  if (config.role === "installer") {
    await installManagedPreset();
    return;
  }
  if (config.role === "agent") return registerNativeSdr(ctx, config);
}

export { ConnectorRegistry, JsonStore, SdrService, defaultStorePath, installManagedPreset, targetPreset };
export { HybridRagRetriever, evaluateRetrieval, splitIntoChunks } from "./rag.js";
export { POSTGRES_RAG_SCHEMA, PostgresKnowledgeRepository } from "./postgres-rag.js";

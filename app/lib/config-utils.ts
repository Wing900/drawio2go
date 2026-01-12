import {
  ActiveModelReference,
  AgentSettings,
  ModelConfig,
  ProviderConfig,
  ProviderType,
  type SkillKnowledgeId,
  type RuntimeLLMConfig,
  type SkillSettings,
} from "@/app/types/chat";
import { getDefaultCapabilities } from "@/app/lib/model-capabilities";
import type { StorageAdapter } from "@/app/lib/storage/adapter";
import { createLogger } from "@/lib/logger";

const logger = createLogger("LLM");

export const CANVAS_CONTEXT_GUIDE = `The user's message may include context tags:

1. **\`<drawio_status vertices="X" edges="Y"/>\`**: Total count of nodes and edges (no IDs provided)
2. **\`<user_select>id1,id2,id3</user_select>\`**: Comma-separated IDs of user-selected elements (Electron only; unavailable in Web)
3. **\`<page_scope pages="N">...</page_scope>\`**: User has selected specific pages (not all). Contains a table with page names and ready-to-use XPath for each page. Use the provided XPath directly as insert target (e.g., \`xpath: "//diagram[@id='page-1']/mxGraphModel/root"\`). Operations MUST be scoped to these pages only.

These tags help you understand the current diagram state and scope.`;

export const LAYOUT_CHECK_GUIDE = `Layout check is enabled.

After each \`drawio_edit_batch\`, the system automatically checks for overlaps between connectors (edges) and other elements.

If overlaps are detected, tool results may include a \`warnings\` array and a \`layout_check\` object with overlap details (including coordinates).

When overlaps occur, **prefer adjusting the connector (edge) path** by adding waypoints to route around vertices, rather than moving the vertices. Connectors are more flexible and easier to reroute. Use the \`seg\` coordinates to identify which segment overlaps and add appropriate waypoints.

Only ask the user if the overlap appears intentional or if adjusting the connector would significantly affect the diagram's clarity.`;

export const DEFAULT_SYSTEM_PROMPT = `# 🚀 System Prompt: DrawIO XML Core Engine

## 1. 🟢 角色层 (Role Definition)

**Identity**: 你是 **DrawIO XML 核心编译引擎 (MXGraph Serializer)**。
**Core Function**: 你的任务不是"绘画"，而是**"拓扑计算"与"数据序列化"**。你必须将自然语言需求转换为**未经压缩 (Uncompressed)**、**语法完美**的 \`mxGraphModel\` XML 代码。

---

## 2. 🔵 知识层 (Knowledge Base)

### 2.1 核心数据结构 (Schema)

你必须严格遵守以下 XML 骨架：

<mxfile host="Electron">
  <diagram id="diagram_1" name="Page-1">
    <mxGraphModel grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" page="1">
      <root>
        <!-- 系统内核节点 (不可修改) -->
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <!-- 用户数据区 -->
        ...
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>

### 2.2 坐标与网格系统 (Coordinate System)

*   **原点**: $(0, 0)$ 位于画布左上角。
*   **方向**: $X$ 轴向右增加，$Y$ 轴向下增加。
*   **栅格化 (Snap to Grid)**: 所有 \`x, y\` 坐标必须是 \`10\` 的倍数。
*   **相对坐标**: 若节点在组 (Group) 内，其 \`x, y\` 是相对于父容器左上角的偏移量。

---

## 3. 🔴 规范层 (Constraint Layer - MUST/MUST NOT)

### 3.1 🚫 绝对禁止 (Prohibitions)

1.  **NO Compression**: 严禁生成 Base64 或 Gzip 压缩字符串。只输出 **Raw XML**。
2.  **NO Logic Hardcoding**: 严禁在逻辑连线上硬编码 \`<mxPoint>\` 路径点。必须依赖 \`source="{id}"\` 和 \`target="{id}"\` 让渲染引擎自动路由。
3.  **NO ID Collision**: 文件内 ID 必须全局唯一（请使用语义化 ID+乱码，如 \`db_primary_ufdab231\`）。
4.  **NO Syntax Errors**: 属性值必须用双引号 \`"\` 包裹。若在 JSON 中输出，务必转义为 \`\\"\`。

### 3.2 🛠️ API 协议修正 (API Protocol)

**调用 \`drawio_edit_batch\` 时，JSON 结构必须符合 Zod 校验：**

1.  **Targeting Mandatory**: 在 \`insert_element\` 操作中，外层 JSON 对象**必须**包含 \`id\` 字段（指定父节点）。
    *   ❌ **Wrong**: \`{"type": "insert_element", "new_xml": "..."}\`
    *   ✅ **Right**: \`{"type": "insert_element", "id": "1", "new_xml": "..."}\` (针对默认图层)
    *   ✅ **Right**: \`{"type": "insert_element", "id": "my_group_id", "new_xml": "..."}\` (针对组内节点)

### 3.3 ✅ 强制执行 (Mandates)

1.  **完整闭合**: 所有的 \`mxCell\` 必须正确闭合。
2.  **节点属性**:
    *   形状节点必须带 \`vertex="1"\`。
    *   连线必须带 \`edge="1"\` 且 \`<mxGeometry relative="1" ... />\`。
3.  **父子归属**:
    *   普通节点 \`parent="1"\`。
    *   图层节点 \`parent="0"\`。
    *   组内节点 \`parent="{group_id}"\`。
4.  **文本转义**: 节点 Label 中若包含 HTML 标签，必须转义（如 \`<br>\`）或包裹在 \`html=1\` 模式下。

### 3.4 锚点规则

**动态锚点 (Dynamic Anchoring)**: 不要把 \`entryX/exitX\` 硬编码在全局 Style 字符串里。

- **上下布局**: Source \`exitY=1\` (Bottom), Target \`entryY=0\` (Top).
- **左右布局**: Source \`exitX=1\` (Right), Target \`entryX=0\` (Left).
- **回环/反馈**: Source \`exitX=0\`, Target \`entryX=0\` (Left-to-Left).

### 3.5 计算规则

**容器自适应计算 (Container Sizing)**: 如果存在 Group，其 \`width\` 和 \`height\` 必须根据子节点计算：

- $GroupWidth = \\max(ChildX + ChildWidth) + Padding$
- $GroupHeight = \\max(ChildY + ChildHeight) + Padding$
- (Padding 建议至少 20px)

### 3.6 连线规则

**连线标签 (Edge Labeling)**: 连线上的文字直接写入 Edge \`mxCell\` 的 \`value\` 属性中。 同时必须在 Edge 的 style 中追加: \`labelBackgroundColor=#ffffff;\` (添加白底背景，防止文字和线条重叠看不清)。

---

## 4. 🟣 协议层 (Protocol & Workflow)

### 思维链

收到绘图需求时，请按以下**三步思维链 (Chain of Thought)** 处理，直接输出 XML：

**Step 1: 拓扑映射 (Topology Mapping)**

*   确定实体间的连接关系 (Source -> Target)。

**Step 2: 空间计算 (Spatial Calculation)**

*   **布局策略**: 默认采用**自上而下**或**从左到右**的流式布局。
*   **防重叠算法**:
    *   定义基准间距：$GapX = 40, GapY = 60$。
    *   计算公式：$NextX = PrevX + Width + GapX$。
    *   **关键**: 必须在脑中构建虚拟网格，确保没有任何两个 $(x, y, w, h)$ 矩形发生碰撞。

**Step 3: 编译输出 (Compilation)**

*   生成 XML 头。
*   写入 \`<root>\` 和系统 ID。
*   写入 Vertex 节点（带计算好的 Geometry）。
*   写入 Edge 连线（关联 Source/Target）。
*   闭合标签。

---

### 🌟 初始化指令 (Initialization)

请听从英文的底层指令。当用户对话时，积极给出方案。

`;


// 各供应商官方 API URL 默认值
export const DEFAULT_OPENAI_API_URL = "https://api.openai.com/v1";
export const DEFAULT_DEEPSEEK_API_URL = "https://api.deepseek.com";
export const DEFAULT_ANTHROPIC_API_URL = "https://api.anthropic.com";
export const DEFAULT_GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta";
// 通用默认值（用于 OpenAI 兼容类型）
export const DEFAULT_API_URL = DEFAULT_OPENAI_API_URL;

export function isProviderType(value: unknown): value is ProviderType {
  return (
    value === "openai-reasoning" ||
    value === "openai-compatible" ||
    value === "deepseek-native" ||
    value === "anthropic" ||
    value === "gemini"
  );
}

/**
 * 获取指定供应商类型的默认 API URL
 */
export const getDefaultApiUrlForProvider = (
  providerType: ProviderType,
): string => {
  switch (providerType) {
    case "gemini":
      return DEFAULT_GEMINI_API_URL;
    case "anthropic":
      return DEFAULT_ANTHROPIC_API_URL;
    case "deepseek-native":
      return DEFAULT_DEEPSEEK_API_URL;
    case "openai-reasoning":
    case "openai-compatible":
    default:
      return DEFAULT_OPENAI_API_URL;
  }
};

export const normalizeProviderApiUrl = (
  providerType: ProviderType,
  value?: string,
  fallback?: string,
): string => {
  if (typeof value === "string") return value;
  return fallback ?? getDefaultApiUrlForProvider(providerType);
};

export const STORAGE_KEY_LLM_PROVIDERS = "settings.llm.providers";
export const STORAGE_KEY_LLM_MODELS = "settings.llm.models";
export const STORAGE_KEY_AGENT_SETTINGS = "settings.llm.agent";
export const STORAGE_KEY_ACTIVE_MODEL = "settings.llm.activeModel";

export const STORAGE_KEY_GENERAL_SETTINGS = "settings.general";

export type DrawioTheme = "kennedy" | "min" | "atlas" | "sketch" | "simple";

export const DEFAULT_DRAWIO_BASE_URL = "https://embed.diagrams.net";
export const DEFAULT_DRAWIO_IDENTIFIER = "diagrams.net";
export const DEFAULT_DRAWIO_THEME: DrawioTheme = "kennedy";

export const DRAWIO_THEME_OPTIONS: DrawioTheme[] = [
  "kennedy",
  "min",
  "atlas",
  "sketch",
  "simple",
];

export function isDrawioTheme(value: unknown): value is DrawioTheme {
  return (
    value === "kennedy" ||
    value === "min" ||
    value === "atlas" ||
    value === "sketch" ||
    value === "simple"
  );
}

export interface GeneralSettings {
  // 默认展开侧边栏
  sidebarExpanded: boolean;
  // 默认文件路径
  defaultPath: string;
  // DrawIO Base URL（用于 iframe src 构建）
  drawioBaseUrl?: string;
  // DrawIO 标识符（用于 postMessage origin 验证）
  drawioIdentifier?: string;
  // DrawIO 默认主题（URL 参数 ui=）
  drawioTheme?: DrawioTheme;
  // 自定义 URL 参数（如 "spin=0&libraries=0"，可覆盖默认参数）
  drawioUrlParams?: string;
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  sidebarExpanded: true,
  defaultPath: "",
};

// 默认不预置任何 providers/models（需要用户在设置中创建）
export const DEFAULT_PROVIDERS: ProviderConfig[] = [];
export const DEFAULT_MODELS: ModelConfig[] = [];

export const DEFAULT_SKILL_SETTINGS: SkillSettings = {
  selectedTheme: "modern",
  selectedKnowledge: ["general"],
  customThemePrompt: "",
  customKnowledgeContent: "",
  selectedColorTheme: "default",
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  updatedAt: Date.now(),
  skillSettings: DEFAULT_SKILL_SETTINGS,
};

export const DEFAULT_ACTIVE_MODEL: ActiveModelReference | null = null;

export const DEFAULT_LLM_CONFIG: RuntimeLLMConfig = Object.freeze({
  apiUrl: "",
  apiKey: "",
  // 仅作为结构兜底，不代表实际已配置的供应商/模型
  providerType: "openai-compatible" as const,
  modelName: "",
  temperature: 0.3,
  maxToolRounds: 20,
  capabilities: getDefaultCapabilities(null),
  enableToolsInThinking: false,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  customConfig: {},
});

const toFiniteNumber = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const normalizeCustomConfig = (
  customConfig: unknown,
): RuntimeLLMConfig["customConfig"] => {
  if (
    customConfig &&
    typeof customConfig === "object" &&
    !Array.isArray(customConfig)
  ) {
    return {
      ...DEFAULT_LLM_CONFIG.customConfig,
      ...(customConfig as RuntimeLLMConfig["customConfig"]),
    };
  }
  return { ...DEFAULT_LLM_CONFIG.customConfig };
};

const normalizeSkillSettings = (value: unknown): SkillSettings | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const selectedTheme =
    typeof record.selectedTheme === "string" && record.selectedTheme.trim()
      ? record.selectedTheme
      : DEFAULT_SKILL_SETTINGS.selectedTheme;

  const selectedKnowledge = Array.isArray(record.selectedKnowledge)
    ? record.selectedKnowledge.filter(
        (item): item is SkillKnowledgeId =>
          typeof item === "string" && item.trim().length > 0,
      )
    : DEFAULT_SKILL_SETTINGS.selectedKnowledge;

  const customThemePrompt =
    typeof record.customThemePrompt === "string"
      ? record.customThemePrompt
      : DEFAULT_SKILL_SETTINGS.customThemePrompt;

  const customKnowledgeContent =
    typeof record.customKnowledgeContent === "string"
      ? record.customKnowledgeContent
      : DEFAULT_SKILL_SETTINGS.customKnowledgeContent;

  const selectedColorTheme =
    typeof record.selectedColorTheme === "string" &&
    record.selectedColorTheme.trim()
      ? record.selectedColorTheme
      : DEFAULT_SKILL_SETTINGS.selectedColorTheme;

  return {
    selectedTheme,
    selectedKnowledge:
      selectedKnowledge.length > 0
        ? selectedKnowledge
        : DEFAULT_SKILL_SETTINGS.selectedKnowledge,
    customThemePrompt,
    customKnowledgeContent,
    selectedColorTheme,
  };
};

/**
 * 规范化运行时 LLM 配置
 * - 合并默认值
 * - 保持 API URL 原始值（完全尊重用户输入）
 * - 确保类型安全（数字/字符串校验、能力回退）
 */
export function normalizeLLMConfig(
  config?: Partial<RuntimeLLMConfig> | null,
): RuntimeLLMConfig {
  const safeConfig = config ?? {};

  const providerType = isProviderType(safeConfig.providerType)
    ? safeConfig.providerType
    : DEFAULT_LLM_CONFIG.providerType;

  const apiUrl = normalizeProviderApiUrl(providerType, safeConfig.apiUrl);

  const modelName =
    typeof safeConfig.modelName === "string" && safeConfig.modelName.trim()
      ? safeConfig.modelName.trim()
      : DEFAULT_LLM_CONFIG.modelName;

  const capabilities =
    safeConfig.capabilities ?? getDefaultCapabilities(modelName);

  const enableToolsInThinking =
    typeof safeConfig.enableToolsInThinking === "boolean"
      ? safeConfig.enableToolsInThinking
      : capabilities.supportsThinking;

  const systemPrompt =
    typeof safeConfig.systemPrompt === "string" &&
    safeConfig.systemPrompt.trim()
      ? safeConfig.systemPrompt
      : DEFAULT_SYSTEM_PROMPT;

  const customConfig = normalizeCustomConfig(safeConfig.customConfig);
  const skillSettings = normalizeSkillSettings(safeConfig.skillSettings);

  return {
    apiUrl,
    apiKey:
      typeof safeConfig.apiKey === "string"
        ? safeConfig.apiKey
        : DEFAULT_LLM_CONFIG.apiKey,
    providerType,
    modelName,
    temperature: toFiniteNumber(
      safeConfig.temperature,
      DEFAULT_LLM_CONFIG.temperature,
    ),
    maxToolRounds: Math.max(
      1,
      Math.round(
        toFiniteNumber(
          safeConfig.maxToolRounds,
          DEFAULT_LLM_CONFIG.maxToolRounds,
        ),
      ),
    ),
    capabilities,
    enableToolsInThinking,
    systemPrompt,
    skillSettings,
    customConfig,
  };
}

export async function initializeDefaultLLMConfig(
  storage: StorageAdapter,
): Promise<void> {
  try {
    const existingProviders = await storage.getSetting(
      STORAGE_KEY_LLM_PROVIDERS,
    );

    if (existingProviders !== null) {
      return;
    }
    // 默认不再写入任何 provider/model 配置
  } catch (error) {
    logger.error("Failed to initialize default LLM config", { error });
  }
}

// ==================== 内置 Provider 配置 ====================

/**
 * 内置 Provider 配置类型（从环境变量读取）
 */
export interface BuiltinProviderConfig {
  displayName: string;
  providerType: ProviderType;
  apiUrl: string;
  apiKey: string;
  models: BuiltinModelConfig[];
}

export interface BuiltinModelConfig {
  modelName: string;
  displayName: string;
  temperature?: number;
  maxToolRounds?: number;
  isDefault?: boolean;
}

/**
 * 内置 Provider/Model ID 前缀
 */
export const BUILTIN_PROVIDER_ID = "builtin-provider";
export const BUILTIN_MODEL_ID_PREFIX = "builtin-model-";

/**
 * 环境变量名称
 * 必须使用 NEXT_PUBLIC_ 前缀才能在客户端访问
 */
export const ENV_BUILTIN_PROVIDER = "NEXT_PUBLIC_DRAWIO2GO_BUILTIN_PROVIDER";

/**
 * 从环境变量解析内置 Provider 配置
 * 格式示例：
 * NEXT_PUBLIC_DRAWIO2GO_BUILTIN_PROVIDER='{"displayName":"内置AI","providerType":"openai-compatible","apiUrl":"https://api.example.com/v1","apiKey":"sk-xxx","models":[{"modelName":"gpt-4","displayName":"GPT-4"}]}'
 *
 * 注意：Edge Runtime 兼容 - 直接读取 NEXT_PUBLIC_ 前缀的环境变量（编译时注入）
 */
export function parseBuiltinProvider(): BuiltinProviderConfig | null {
  const envValue = process.env.NEXT_PUBLIC_DRAWIO2GO_BUILTIN_PROVIDER;

  if (!envValue || typeof envValue !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(envValue) as BuiltinProviderConfig;

    // 验证必需字段
    if (
      typeof parsed.displayName !== "string" ||
      typeof parsed.providerType !== "string" ||
      typeof parsed.apiUrl !== "string" ||
      typeof parsed.apiKey !== "string" ||
      !Array.isArray(parsed.models)
    ) {
      logger.warn("Invalid builtin provider config: missing required fields");
      return null;
    }

    if (!isProviderType(parsed.providerType)) {
      logger.warn("Invalid builtin provider config: invalid providerType");
      return null;
    }

    return {
      displayName: parsed.displayName,
      providerType: parsed.providerType,
      apiUrl: parsed.apiUrl,
      apiKey: parsed.apiKey,
      models: parsed.models.filter(
        (m) =>
          typeof m.modelName === "string" && typeof m.displayName === "string",
      ),
    };
  } catch (error) {
    logger.error("Failed to parse builtin provider config", { error });
    return null;
  }
}

/**
 * 检查是否启用了内置 Provider
 */
export function isBuiltinProviderEnabled(): boolean {
  return parseBuiltinProvider() !== null;
}

/**
 * 获取内置 Provider 配置（转换为 ProviderConfig 格式）
 */
export function getBuiltinProvider(): ProviderConfig | null {
  const builtin = parseBuiltinProvider();
  if (!builtin) return null;

  const now = Date.now();
  return {
    id: BUILTIN_PROVIDER_ID,
    displayName: builtin.displayName,
    providerType: builtin.providerType,
    apiUrl: builtin.apiUrl,
    apiKey: builtin.apiKey,
    models: builtin.models.map((m) => BUILTIN_MODEL_ID_PREFIX + m.modelName),
    customConfig: {},
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 获取内置 Model 配置列表
 */
export function getBuiltinModels(): ModelConfig[] {
  const builtin = parseBuiltinProvider();
  if (!builtin) return [];

  const now = Date.now();
  return builtin.models.map((m, index) => ({
    id: BUILTIN_MODEL_ID_PREFIX + m.modelName,
    providerId: BUILTIN_PROVIDER_ID,
    modelName: m.modelName,
    displayName: m.displayName,
    temperature: m.temperature ?? 0.3,
    maxToolRounds: m.maxToolRounds ?? 20,
    isDefault: m.isDefault ?? index === 0,
    capabilities: getDefaultCapabilities(m.modelName),
    enableToolsInThinking: false,
    customConfig: {},
    createdAt: now,
    updatedAt: now,
  }));
}

// XML 骨架模板（用于 System Prompt，避免模板字符串中的代码块解析问题）
const XML_SKELETON = `<mxfile host="Electron">
  <diagram id="diagram_1" name="Page-1">
    <mxGraphModel grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" page="1">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        ...
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

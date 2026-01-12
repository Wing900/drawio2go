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

export const DEFAULT_SYSTEM_PROMPT = `You are a professional DrawIO diagram assistant. You safely read and edit diagrams using XPath-driven tools. All diagrams are stored as XML, and you interact with them through structured tool calls.

## A. DrawIO XML Fundamentals

DrawIO stores diagrams as XML with a specific hierarchy:
- **Root path**: \`/mxfile/diagram/mxGraphModel/root\`
- **Internal nodes**: \`<mxCell id="0"/>\` and \`<mxCell id="1"/>\` are system-reserved. NEVER modify or target them.
- **Coordinate system**: Origin (0,0) is at the top-left corner. Units are pixels. Positive X goes right, positive Y goes down.

There are two types of diagram elements:

1. **Vertex (Node/Shape)**: A visual box or shape
\`\`\`xml
<mxCell id="node-1" value="Text" style="rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf" vertex="1" parent="1">
  <mxGeometry x="100" y="50" width="120" height="60" as="geometry"/>
</mxCell>
\`\`\`
- \`vertex="1"\`: marks this as a vertex
- \`parent="1"\`: always attach to the root layer
- \`<mxGeometry x y width height/>\`: position and size in pixels

2. **Edge (Connector/Line)**: A line connecting two nodes
\`\`\`xml
<mxCell id="edge-1" value="" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;endFill=1" edge="1" parent="1" source="node-1" target="node-2">
  <mxGeometry relative="1" as="geometry">
    <Array as="points">
      <mxPoint x="240" y="120"/>
      <mxPoint x="240" y="220"/>
    </Array>
  </mxGeometry>
</mxCell>
\`\`\`
- \`edge="1"\`: marks this as an edge
- \`source="..."\` and \`target="..."\`: IDs of connected nodes
- \`<Array as="points">\`: optional waypoints for routing (see section B)

**Value Attribute (Text Content)**:
- DrawIO renders the \`value\` attribute as **HTML**, not plain text
- **IMPORTANT**: When using HTML tags in \`value\`, you MUST add \`html=1\` to the \`style\` attribute
  - ✅ \`style="rounded=1;html=1;fillColor=#dae8fc"\` with \`value="Line 1<br>Line 2"\`
  - ❌ \`style="rounded=1;fillColor=#dae8fc"\` with \`value="Line 1<br>Line 2"\` → HTML not rendered
- ❌ Wrong: \`value="Line 1\\nLine 2"\` → DrawIO displays literal \`\\n\` characters
- ✅ Correct: \`value="Line 1<div>Line 2</div>"\` → DrawIO renders two lines (with \`html=1\` in style)
- Supported HTML tags: \`<div>\`, \`<br>\`, \`<b>\`, \`<i>\`, \`<u>\`, \`<font color="..." size="...">\`
- Use \`<div>\` or \`<br>\` for line breaks, not \`\\n\`

## B. ID Generation Rule (Critical)

**To prevent "Duplicate ID" crashes, you MUST follow these rules:**

1. **Random IDs**: Do NOT use semantic IDs like \`id="start"\`, \`id="center"\`, or \`id="node1"\`.
   - ❌ **Bad**: \`id="user_login"\`, \`id="process_step"\`, \`id="decision"\`
   - ✅ **Good**: \`id="n_8a7b2"\`, \`id="e_9x2d1"\`, \`id="c_5f3a9"\`
   - Use short random alphanumeric suffixes (4-6 characters)

2. **Uniqueness**: Every \`id\` in your batch must be unique and unlikely to collide with existing diagram elements.

3. **Format**: Use prefix \`n_\` for nodes, \`e_\` for edges, \`c_\` for containers.
   - ✅ \`id="n_a1b2c3"\` (node)
   - ✅ \`id="e_d4e5f6"\` (edge)
   - ❌ \`id="start"\` (semantic - forbidden)

**Example:**
\`\`\`xml
<mxCell id="n_8f9a2" value="New Node" style="rounded=1" vertex="1" parent="1">
  <mxGeometry x="100" y="100" width="120" height="60" as="geometry"/>
</mxCell>
<mxCell id="e_3b7c8" edge="1" parent="1" source="n_8f9a2" target="n_2d4e6"/>
\`\`\`

## C. Edge Routing (Critical!)

**DrawIO does NOT auto-layout edges.** If you create an edge without explicit routing, it may overlap nodes or take chaotic paths.

**Best practice**: Use orthogonal routing with explicit waypoints.

**Manhattan Routing Strategy**:
1. Calculate the center points of source and target nodes
2. Pick a midpoint between them (e.g., midX or midY)
3. Add 2-4 waypoints to create right-angle turns
4. Add detours if the path would cross other nodes

**Example**: Connect Node A (center: 160,80) to Node B (center: 320,240)
\`\`\`xml
<mxCell id="edge-1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1" edge="1" parent="1" source="A" target="B">
  <mxGeometry relative="1" as="geometry">
    <Array as="points">
      <mxPoint x="240" y="80"/>
      <mxPoint x="240" y="240"/>
    </Array>
  </mxGeometry>
</mxCell>
\`\`\`
- First point (240,80): horizontal line from A's center
- Second point (240,240): vertical line down to B's center

## D. Style System

Styles are semicolon-separated key-value pairs in the \`style\` attribute.

**Format rules**:
- Syntax: \`key1=value1;key2=value2;key3=value3\` (NO trailing semicolon)
- Self-closing tags: \`<mxGeometry .../>\` (NO space before \`/>\`)

**Common style properties**:
| Property | Purpose | Example Values |
|----------|---------|----------------|
| \`fillColor\` | Fill color | \`#dae8fc\`, \`#f8cecc\` |
| \`strokeColor\` | Border color | \`#6c8ebf\`, \`#b85450\` |
| \`strokeWidth\` | Border width | \`1\`, \`2\`, \`3\` |
| \`rounded\` | Rounded corners | \`0\` (off), \`1\` (on) |
| \`fontSize\` | Text size | \`12\`, \`14\`, \`16\` |
| \`fontColor\` | Text color | \`#000000\`, \`#ffffff\` |
| \`shape\` | Shape type | \`rectangle\`, \`ellipse\`, custom IDs |
| \`edgeStyle\` | Edge routing | \`orthogonalEdgeStyle\`, \`entityRelationEdgeStyle\` |
| \`endArrow\` | Arrow end type | \`block\`, \`classic\`, \`open\`, \`none\` |
| \`endFill\` | Fill arrow head | \`0\` (hollow), \`1\` (filled) |

## E. Canvas Context

{{canvas_context_guide}}

{{layout_check_guide}}

## F. Style Theme

{{theme}}

{{colorTheme}}

## G. Knowledge Library

{{knowledge}}

## H. Workflow (Step-by-Step)

**1. Read First**
- ALWAYS call \`drawio_read\` before editing to understand the current state
- Use \`filter: "vertices"\` or \`filter: "edges"\` to narrow results
- Query by \`id\` for specific elements or \`xpath\` for patterns

**2. Plan Layout**
- Decide on a grid system (e.g., 200px horizontal spacing, 100px vertical spacing)
- Calculate positions for new elements to avoid overlaps
- Plan edge routing with explicit waypoints

**3. Target Precisely**
- **Preferred**: Use exact \`id\` for operations
- **Alternative**: Re-use \`matched_xpath\` from \`drawio_read\` results

**4. Batch is Sequential**
- \`drawio_edit_batch\` executes operations in order
- **Stops at the first failure** — if one operation fails, subsequent ones are skipped
- After a failure, call \`drawio_read\` to verify state, then continue

## I. XML Formatting Rules

**For \`insert\` and \`replace\` operations**:
- \`style\`: semicolon-separated, **NO trailing semicolon**
  - ✅ \`fillColor=#dae8fc;strokeColor=#6c8ebf\`
  - ❌ \`fillColor=#dae8fc;strokeColor=#6c8ebf;\`
- Self-closing tags: \`<mxGeometry .../>\` (no space before \`/>\`)
  - ✅ \`<mxGeometry x="100" y="50" width="120" height="60" as="geometry"/>\`
  - ❌ \`<mxGeometry x="100" y="50" width="120" height="60" as="geometry" />\`
- Consistency: Don't mix \`html=0\` and \`html=1\` modes without reason
- **Safe no-op**: Use \`allow_no_match: true\` when an operation should silently succeed even if the target is missing

## H2. **CRITICAL: insert_element Target Constraint** ⚠️

When using \`drawio_edit_batch\` with \`type: "insert_element"\`, you **MUST** provide the \`id\` field to specify the target parent container:

- **Top-Level Nodes**: Set \`"id": "1"\` (targets the Default Layer root)
- **Nested Nodes (inside a Group)**: Set \`"id": "{group_container_id}"\`

**❌ WRONG (Will Fail Validation):**
\`\`\`json
{ "type": "insert_element", "new_xml": "...", "position": "append_child" }
\`\`\`

**✅ RIGHT (Will Pass Validation):**
\`\`\`json
{ "type": "insert_element", "id": "1", "new_xml": "...", "position": "append_child" }
\`\`\`

**Note**: The \`parent="1"\` attribute in your XML string is NOT sufficient — you must provide the \`id\` field in the JSON operation object.

## I. Using Knowledge IDs

Knowledge IDs map library shapes to semantic meanings (e.g., cloud service icons, flowchart symbols).

**Usage in \`style\`**:
- **Standard libraries**: \`shape=<knowledge_id>\`
  - Example: \`style="shape=mxgraph.flowchart.decision;fillColor=#fff2cc"\`
- **Azure/image libraries**: \`shape=image;image=<path>\`
  - Example: \`style="shape=image;image=img/lib/azure2/compute/VM.svg"\`

Refer to the Knowledge section (F) for available IDs.

## J. Output Language

Always respond in the same language the user uses.`;

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

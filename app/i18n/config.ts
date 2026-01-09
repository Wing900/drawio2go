// 国际化基础配置：语言、命名空间与类型定义

// 可用语言列表（中文优先）
export const locales = ["zh-CN", "en-US"] as const;
export type Locale = (typeof locales)[number];

// 默认语言（用于初始加载与兜底回退）
export const defaultLocale = "zh-CN" as const;

// 命名空间列表：对应各功能模块的文案分区
export const namespaces = [
  "common",
  "topbar",
  "sidebar",
  "chat",
  "settings",
  "version",
  "project",
  "errors",
  "validation",
  "page",
  "mcp",
] as const;
export type Namespace = (typeof namespaces)[number];

// 语言显示名称映射（用于语言切换器展示）
export const localeDisplayNames: Record<Locale, string> = {
  "en-US": "English",
  "zh-CN": "简体中文",
} as const;

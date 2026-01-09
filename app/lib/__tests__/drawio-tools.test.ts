import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { replaceDrawioXML, waitForMergeValidation } from "../drawio-tools";
import { WIP_VERSION } from "../storage/constants";
import type { StorageAdapter } from "../storage/adapter";
import type { DrawioEditorRef } from "@/app/components/DrawioEditorNative";

// Mock 依赖模块
vi.mock("../storage/storage-factory", () => ({
  getStorage: vi.fn(),
}));

vi.mock("../storage/current-project", () => ({
  resolveCurrentProjectUuid: vi.fn(),
}));

vi.mock("../drawio-xml-utils", () => ({
  normalizeDiagramXml: vi.fn((xml: string) => xml),
  // 保持验证通过，让后续 DrawIO merge 错误分支得以触发
  validateXMLFormat: vi.fn(() => ({ valid: true })),
}));

vi.mock("../storage", () => ({
  buildPageMetadataFromXml: vi.fn(() => ({
    pageCount: 1,
    pageNames: ["Page-1"],
    pages: [{ id: "page-1", name: "Page-1", index: 0 }],
  })),
}));

vi.mock("../storage/xml-version-engine", () => ({
  computeVersionPayload: vi.fn(() =>
    Promise.resolve({
      xml_content: "test",
      source_version_id: null,
      is_keyframe: true,
      diff_chain_depth: 0,
    }),
  ),
  materializeVersionXml: vi.fn(),
}));

vi.mock("../storage/writers", () => ({
  prepareXmlContext: vi.fn((xml: string) => ({
    normalizedXml: xml,
    pageMetadata: {
      pageCount: 1,
      pageNames: ["Page-1"],
      pages: [{ id: "page-1", name: "Page-1", index: 0 }],
    },
    pageNamesJson: '["Page-1"]',
  })),
  persistWipVersion: vi.fn(async (_projectUuid, xmlOrContext) => ({
    versionId: "mock-version-id",
    context:
      typeof xmlOrContext === "string"
        ? {
            normalizedXml: xmlOrContext,
            pageMetadata: {
              pageCount: 1,
              pageNames: ["Page-1"],
              pages: [{ id: "page-1", name: "Page-1", index: 0 }],
            },
            pageNamesJson: '["Page-1"]',
          }
        : xmlOrContext,
  })),
}));

vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-uuid"),
}));

const VALID_XML = `<mxfile><diagram id="1">Valid</diagram></mxfile>`;
const INVALID_XML = `<mxfile><diagram id="1">Invalid</diagram></mxfile>`;

const createMockEditorRef = (
  exportXml: string = VALID_XML,
): { current: DrawioEditorRef } => ({
  current: {
    mergeDiagram: vi.fn(),
    exportDiagram: vi.fn().mockResolvedValue(exportXml),
    loadDiagram: vi.fn(),
    exportSVG: vi.fn(),
    exportPNG: vi.fn(),
    exportJPEG: vi.fn(),
  },
});

const createMockCustomEvent = <T>(type: string, detail: T) =>
  ({
    type,
    detail,
  }) as unknown as CustomEvent<T>;

type MockMxCellElement = { getAttribute: (name: string) => string | null };

const extractMockMxCellsFromXml = (xml: string): MockMxCellElement[] => {
  const matches = xml.match(/<mxCell[^>]*id="[^"]+"[^>]*>/g) ?? [];
  const cells: MockMxCellElement[] = [];

  for (const match of matches) {
    const idMatch = match.match(/id="([^"]+)"/);
    const id = idMatch?.[1] ?? null;
    cells.push({
      getAttribute: (name: string) => (name === "id" ? id : null),
    });
  }

  return cells;
};

class MockDOMParser {
  parseFromString(xml: string) {
    const cells = extractMockMxCellsFromXml(xml);

    const querySelector = (selector: string) => {
      if (selector === "parsererror") return null;
      if (selector === "mxGraphModel") {
        const match = xml.match(/<mxGraphModel[^>]*>[\s\S]*?<\/mxGraphModel>/);
        return match
          ? ({
              outerHTML: match[0],
              querySelectorAll: (innerSelector: string) =>
                innerSelector === "mxCell" ? cells : [],
            } as unknown as Element)
          : null;
      }
      return null;
    };

    const querySelectorAll = (selector: string) =>
      selector === "mxCell" ? cells : [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { querySelector, querySelectorAll } as any;
  }
}

// Mock 存储
const createMockStorage = (
  shouldFailSnapshot = false,
  shouldFailRollback = false,
) => {
  const mockStorage = {
    getProject: vi
      .fn()
      .mockResolvedValue({ id: "project-1", name: "Test Project" }),
    getXMLVersionsByProject: vi.fn().mockResolvedValue([
      {
        id: "version-1",
        semantic_version: WIP_VERSION,
        xml_content: VALID_XML,
        is_keyframe: true,
      },
    ]),
    getXMLVersion: vi.fn(),
    updateXMLVersion: vi.fn(),
    createXMLVersion: vi.fn(),
  };

  if (shouldFailSnapshot) {
    // 模拟快照获取失败
    mockStorage.getXMLVersionsByProject.mockResolvedValue([]);
  }

  if (shouldFailRollback) {
    // 第一次调用成功（保存无效 XML），第二次调用失败（回滚）
    let callCount = 0;
    mockStorage.updateXMLVersion.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve();
      } else {
        return Promise.reject(new Error("Storage unavailable"));
      }
    });
  }

  return mockStorage;
};

describe("replaceDrawioXML - 回滚错误处理", () => {
  let mockDispatchEvent: (event: Event) => boolean;
  // eslint-disable-next-line sonarjs/no-unused-collection -- 用于 mock 事件收集，可供调试使用
  let dispatchedEvents: Event[];
  let listeners: Record<string, Set<(event: Event) => void>>;
  let originalWindow: (Window & typeof globalThis) | undefined;
  let originalDOMParser: typeof DOMParser | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalWindow = global.window as Window & typeof globalThis;
    originalDOMParser = global.DOMParser;

    // Mock window.dispatchEvent 和 addEventListener
    listeners = {};
    dispatchedEvents = [];
    mockDispatchEvent = (event: Event) => {
      dispatchedEvents.push(event);
      const handlers = listeners[event.type];
      handlers?.forEach((fn) => fn(event));
      return true;
    };

    const addEventListener = (
      type: string,
      handler: (event: Event) => void,
      options?: AddEventListenerOptions & { signal?: AbortSignal },
    ) => {
      if (!listeners[type]) {
        listeners[type] = new Set();
      }
      listeners[type].add(handler);
      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          listeners[type]?.delete(handler);
        });
      }
    };

    const removeEventListener = (
      type: string,
      handler: (event: Event) => void,
    ) => listeners[type]?.delete(handler);

    vi.stubGlobal(
      "CustomEvent",
      class<T> {
        type: string;
        detail?: T;
        constructor(type: string, init?: CustomEventInit<T>) {
          this.type = type;
          this.detail = init?.detail;
        }
      } as unknown as typeof CustomEvent,
    );

    global.window = {
      dispatchEvent: mockDispatchEvent,
      addEventListener,
      removeEventListener,
      setTimeout: global.setTimeout,
      clearTimeout: global.clearTimeout,
    } as unknown as Window & typeof globalThis;

    // Mock crypto.randomUUID
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "test-request-id"),
    });

    // Mock DOMParser for XML 验证/比较
    global.DOMParser = MockDOMParser as unknown as typeof DOMParser;
  });

  afterEach(() => {
    if (originalWindow) {
      global.window = originalWindow;
    } else {
      // 确保不留下空 window，避免污染其他测试
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (global as any).window;
    }
    if (originalDOMParser) {
      global.DOMParser = originalDOMParser;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (global as any).DOMParser;
    }
    vi.unstubAllGlobals();
  });

  it("场景 1：回滚成功 - 快照可用且写入成功", async () => {
    const { getStorage } = await import("../storage/storage-factory");
    const { resolveCurrentProjectUuid } =
      await import("../storage/current-project");
    const { materializeVersionXml } =
      await import("../storage/xml-version-engine");

    const mockStorage = createMockStorage();
    vi.mocked(getStorage).mockResolvedValue(
      mockStorage as unknown as StorageAdapter,
    );
    vi.mocked(resolveCurrentProjectUuid).mockResolvedValue("project-1");
    vi.mocked(materializeVersionXml).mockResolvedValue(VALID_XML);

    // 模拟 DrawIO merge 错误事件
    const editorRef = createMockEditorRef();
    setTimeout(() => {
      mockDispatchEvent(
        createMockCustomEvent("drawio-merge-error", {
          error: "merge_failed",
          requestId: "test-request-id",
        }),
      );
    }, 10);

    const result = await replaceDrawioXML(INVALID_XML, { editorRef });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected replaceDrawioXML to fail");
    }
    expect(result.error).toBe("merge_failed");
    expect(result.message).toBe("DrawIO 响应超时。已自动回滚到修改前状态");
    expect(editorRef.current.loadDiagram).toHaveBeenCalled();
  });

  it("场景 2：回滚失败 - 快照未获取", async () => {
    const { getStorage } = await import("../storage/storage-factory");
    const { resolveCurrentProjectUuid } =
      await import("../storage/current-project");
    const { materializeVersionXml } =
      await import("../storage/xml-version-engine");

    // 模拟项目不存在，导致快照获取失败
    const mockStorage = {
      getProject: vi.fn().mockResolvedValue(null), // 项目不存在
      getXMLVersionsByProject: vi.fn(),
      getXMLVersion: vi.fn(),
      updateXMLVersion: vi.fn(),
      createXMLVersion: vi.fn(),
    };

    vi.mocked(getStorage).mockResolvedValue(
      mockStorage as unknown as StorageAdapter,
    );
    vi.mocked(resolveCurrentProjectUuid).mockResolvedValue("project-1");
    vi.mocked(materializeVersionXml).mockResolvedValue(VALID_XML);

    // 第二次调用 getStorage（保存新 XML 时）返回正常的存储
    let getStorageCallCount = 0;
    vi.mocked(getStorage).mockImplementation(async () => {
      getStorageCallCount++;
      if (getStorageCallCount === 1) {
        // 第一次：快照获取时项目不存在
        return mockStorage as unknown as StorageAdapter;
      } else {
        // 第二次：保存时项目存在
        return {
          ...mockStorage,
          getProject: vi
            .fn()
            .mockResolvedValue({ id: "project-1", name: "Test Project" }),
          getXMLVersionsByProject: vi.fn().mockResolvedValue([
            {
              id: "version-1",
              semantic_version: WIP_VERSION,
              xml_content: INVALID_XML,
              is_keyframe: true,
            },
          ]),
        } as unknown as StorageAdapter;
      }
    });

    const editorRef = createMockEditorRef();
    setTimeout(() => {
      mockDispatchEvent(
        createMockCustomEvent("drawio-merge-error", {
          error: "merge_failed",
          requestId: "test-request-id",
        }),
      );
    }, 10);

    const result = await replaceDrawioXML(INVALID_XML, { editorRef });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected replaceDrawioXML to fail");
    }
    expect(result.error).toBe("merge_failed");
    expect(editorRef.current.loadDiagram).toHaveBeenCalled();
  });

  it("场景 3：回滚失败 - 写入失败（存储不可用）", async () => {
    const { getStorage } = await import("../storage/storage-factory");
    const { resolveCurrentProjectUuid } =
      await import("../storage/current-project");
    const { materializeVersionXml } =
      await import("../storage/xml-version-engine");

    // 创建单个 mock 实例，使用 mockResolvedValueOnce 和 mockRejectedValueOnce
    const sharedMockStorage = {
      getProject: vi
        .fn()
        .mockResolvedValue({ id: "project-1", name: "Test Project" }),
      getXMLVersionsByProject: vi.fn().mockResolvedValue([
        {
          id: "version-1",
          semantic_version: WIP_VERSION,
          xml_content: VALID_XML,
          is_keyframe: true,
        },
      ]),
      getXMLVersion: vi.fn(),
      updateXMLVersion: vi
        .fn()
        .mockResolvedValueOnce(undefined) // 第一次调用成功
        .mockRejectedValueOnce(new Error("Storage unavailable")), // 第二次调用失败
      createXMLVersion: vi.fn(),
    };

    // 确保每次调用 getStorage 都返回同一个 mock 实例
    vi.mocked(getStorage).mockResolvedValue(
      sharedMockStorage as unknown as StorageAdapter,
    );
    vi.mocked(resolveCurrentProjectUuid).mockResolvedValue("project-1");
    vi.mocked(materializeVersionXml).mockResolvedValue(VALID_XML);

    const editorRef = createMockEditorRef();
    setTimeout(() => {
      mockDispatchEvent(
        createMockCustomEvent("drawio-merge-error", {
          error: "merge_failed",
          requestId: "test-request-id",
        }),
      );
    }, 10);

    const result = await replaceDrawioXML(INVALID_XML, { editorRef });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected replaceDrawioXML to fail");
    }
    expect(result.error).toBe("merge_failed");
    expect(editorRef.current.loadDiagram).toHaveBeenCalled();
  });

  it("merge 成功且 skipExportValidation=true 时应跳过 export 验证", async () => {
    const { getStorage } = await import("../storage/storage-factory");
    const { resolveCurrentProjectUuid } =
      await import("../storage/current-project");
    const { materializeVersionXml } =
      await import("../storage/xml-version-engine");

    const mockStorage = createMockStorage();
    vi.mocked(getStorage).mockResolvedValue(
      mockStorage as unknown as StorageAdapter,
    );
    vi.mocked(resolveCurrentProjectUuid).mockResolvedValue("project-1");
    vi.mocked(materializeVersionXml).mockResolvedValue(VALID_XML);

    const editorRef = createMockEditorRef("should_not_be_called");
    setTimeout(() => {
      mockDispatchEvent(
        createMockCustomEvent("drawio-merge-success", {
          requestId: "test-request-id",
        }),
      );
    }, 10);

    const result = await replaceDrawioXML(VALID_XML, {
      editorRef,
      skipExportValidation: true,
    });

    expect(result.success).toBe(true);
    expect(editorRef.current.exportDiagram).not.toHaveBeenCalled();
  });
});

describe("waitForMergeValidation - requestId 匹配", () => {
  let listeners: Record<string, Set<(event: Event) => void>>;
  let mockDispatchEvent: (event: Event) => boolean;
  let originalWindow: (Window & typeof globalThis) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    originalWindow = global.window as Window & typeof globalThis;
    listeners = {};
    mockDispatchEvent = (event: Event) => {
      listeners[event.type]?.forEach((fn) => fn(event));
      return true;
    };

    const addEventListener = (
      type: string,
      handler: (event: Event) => void,
      options?: AddEventListenerOptions & { signal?: AbortSignal },
    ) => {
      if (!listeners[type]) {
        listeners[type] = new Set();
      }
      listeners[type].add(handler);
      options?.signal?.addEventListener("abort", () => {
        listeners[type]?.delete(handler);
      });
    };

    const removeEventListener = (
      type: string,
      handler: (event: Event) => void,
    ) => listeners[type]?.delete(handler);

    vi.stubGlobal(
      "CustomEvent",
      class<T> {
        type: string;
        detail?: T;
        constructor(type: string, init?: CustomEventInit<T>) {
          this.type = type;
          this.detail = init?.detail;
        }
      } as unknown as typeof CustomEvent,
    );

    global.window = {
      dispatchEvent: mockDispatchEvent,
      addEventListener,
      removeEventListener,
      setTimeout: global.setTimeout,
      clearTimeout: global.clearTimeout,
    } as unknown as Window & typeof globalThis;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalWindow) {
      global.window = originalWindow;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (global as any).window;
    }
    vi.unstubAllGlobals();
  });

  it("应只响应匹配的 requestId 事件", async () => {
    const requestId1 = "test-request-1";
    const requestId2 = "test-request-2";

    const promise1 = waitForMergeValidation(requestId1, 2000);
    const promise2 = waitForMergeValidation(requestId2, 2000);

    window.dispatchEvent(
      new CustomEvent("drawio-merge-success", {
        detail: { requestId: requestId2 },
      }),
    );

    const result2 = await promise2;
    expect(result2).toMatchObject({ success: true, requestId: requestId2 });

    window.dispatchEvent(
      new CustomEvent("drawio-merge-error", {
        detail: { error: "test_error", requestId: requestId1 },
      }),
    );

    const result1 = await promise1;
    expect(result1).toMatchObject({
      error: "test_error",
      requestId: requestId1,
    });
  });

  it("应忽略不携带 requestId 的事件", async () => {
    const targetRequestId = "test-request-target";
    const promise = waitForMergeValidation(targetRequestId, 1000);

    window.dispatchEvent(
      new CustomEvent("drawio-merge-success", {
        detail: {},
      }),
    );

    window.dispatchEvent(
      new CustomEvent("drawio-merge-success", {
        detail: { requestId: "wrong-request-id" },
      }),
    );

    window.dispatchEvent(
      new CustomEvent("drawio-merge-success", {
        detail: { requestId: targetRequestId },
      }),
    );

    const result = await promise;
    expect(result).toMatchObject({
      success: true,
      requestId: targetRequestId,
    });
  });

  it("应正确序列化复杂错误对象", async () => {
    const requestId = "test-request-error-obj";
    const promise = waitForMergeValidation(requestId, 1000);

    const complexError = {
      code: "XML_INVALID",
      details: { line: 42, column: 15 },
    };

    window.dispatchEvent(
      new CustomEvent("drawio-merge-error", {
        detail: {
          error: complexError,
          message: "XML 格式错误",
          requestId,
        },
      }),
    );

    const result = await promise;
    expect(result?.error).toBe(JSON.stringify(complexError));
    expect(result?.message).toBe("XML 格式错误");
    expect(result?.requestId).toBe(requestId);
  });

  it("超时时应返回默认错误", async () => {
    const requestId = "test-request-timeout";
    const promise = waitForMergeValidation(requestId, 100);

    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toMatchObject({
      error: expect.stringContaining("timeout"),
      message: expect.stringContaining("超时"),
    });
  });
});

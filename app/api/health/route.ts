import { NextResponse } from "next/server";

// Cloudflare Pages 使用 Node.js runtime
// export const runtime = "edge";

const headers = {
  "Cache-Control": "no-store, max-age=0",
};

export async function HEAD() {
  console.log("[CF-DEBUG] Health HEAD 请求");
  return new NextResponse(null, { status: 204, headers });
}

export async function GET() {
  console.log("[CF-DEBUG] Health GET 请求");
  console.log("[CF-DEBUG] Runtime:", typeof process !== "undefined" ? "Node.js" : "Edge");
  console.log("[CF-DEBUG] CF_PAGES:", typeof process !== "undefined" ? process.env.CF_PAGES : "N/A");
  
  try {
    const response = { ok: true, timestamp: Date.now() };
    console.log("[CF-DEBUG] Health 响应:", response);
    return NextResponse.json(response, { headers });
  } catch (error) {
    console.error("[CF-DEBUG] Health 错误:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500, headers }
    );
  }
}

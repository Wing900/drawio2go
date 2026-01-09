/** @type {import('next').NextConfig} */
const isVercel = Boolean(process.env.VERCEL);
// Cloudflare Pages 自动注入 CF_PAGES 环境变量（任意真值）
const isCloudflarePages = Boolean(process.env.CF_PAGES);

console.log("[Next Config] 环境检测:", {
  isVercel,
  isCloudflarePages,
  CF_PAGES: process.env.CF_PAGES,
  VERCEL: process.env.VERCEL,
  NODE_ENV: process.env.NODE_ENV,
});

const nextConfig = {
  // 优化 HeroUI 导入
  transpilePackages: ["@heroui/react", "@heroui/styles"],

  // 实验性功能：优化包导入
  experimental: {
    optimizePackageImports: ["@heroui/react"],
  },

  // Electron 生产模式需要内嵌完整服务器（standalone）
  // Vercel 和 Cloudflare Pages 使用默认输出
  ...(isVercel || isCloudflarePages ? {} : { output: "standalone" }),

  // 图片优化配置
  images: {
    // Electron 环境无法使用 Next.js 图片优化服务
    unoptimized: !isVercel && !isCloudflarePages,
  },
};

console.log("[Next Config] 最终配置:", {
  output: nextConfig.output,
  imagesUnoptimized: nextConfig.images.unoptimized,
});

export default nextConfig;

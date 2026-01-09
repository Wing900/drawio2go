/** @type {import('next').NextConfig} */
const isVercel = Boolean(process.env.VERCEL);
const isCloudflarePages = process.env.CF_PAGES === "1";

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

export default nextConfig;

import { defineConfig } from 'astro/config';

// 静态站默认就是 output: 'static'，无需额外配置。
// 部署到 EdgeOne Pages 时：
//   - site 填自定义域名，仅影响 sitemap 和绝对链接（canonical），不填也能跑。
//   - 输出目录为 dist/，构建命令 astro build；在 EdgeOne 控制台连仓库后自动接管。
//   - 自定义子域名 qdii.liqt91.top 在 EdgeOne 控制台「自定义域名」绑定后，DNS 给 qdii 加 CNAME 即可。
export default defineConfig({
  // 已绑定自定义子域名，用于生成绝对链接 / sitemap。
  site: 'https://qdii.liqt91.top',
  // base: '/',
  trailingSlash: 'ignore',
});

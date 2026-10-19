import { defineConfig } from 'astro/config';

// 静态站默认就是 output: 'static'，无需额外配置。
// 部署到腾讯云 COS 静态网站时：
//   - 若用「自定义域名」直接绑到 bucket 根，site 填该域名即可，base 留空。
//   - 若挂在子路径（例如 https://xxx.cos-website.../nasdaq/），把 base 改成 '/nasdaq'。
export default defineConfig({
  // TODO: 替换成你的 COS 静态网站域名（或自定义域名），用于生成绝对链接/sitemap。
  site: 'https://YOUR-BUCKET.cos-website.ap-guangzhou.myqcloud.com',
  // base: '/',
  trailingSlash: 'ignore',
});

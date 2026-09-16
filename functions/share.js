/*
 * Ant Motors — 分享落地页（WeChat / 社交卡片 OG 标签服务端渲染）
 *
 * 分享链接统一走 /share?c=<车ID>&ref=<销售ID>（首页分享只带 ref）。
 * 关键：微信 / 社交 App 的爬虫**不执行 JS**，只读取服务端返回的 HTML <head> 里的
 * OG 标签。所以必须在这一层把对应车的封面图 / 标题 / 价格写进 OG，好友才会看到
 * 带封面的分享卡片。真实用户（Webview）则通过 <meta refresh> + JS 重定向到 SPA 详情页。
 *
 * 部署：Cloudflare Pages Functions，自动映射为路由 /share。
 * 复用与 [[route]].js 相同的 Supabase 初始化（service_role，仅服务端）。
 */
import { createClient } from '@supabase/supabase-js';

// Supabase 项目 URL（公开信息，写死以避免拼写类事故；与 [[route]].js 保持一致）
const SUPABASE_URL_FIXED = 'https://mcjvlohnyfkvkftrvxeq.supabase.co';
// 没有封面图时的兜底 OG 图（站点自有图标，绝对地址）
const DEFAULT_OG_IMAGE = 'https://antmotors.pages.dev/icon-512.png';
const BRAND = 'Ant Motors';

let sb = null;
function getSb(env) {
  if (!sb) {
    sb = createClient(SUPABASE_URL_FIXED, env.SUPABASE_SERVICE_ROLE_KEY || '', {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }
  return sb;
}

// HTML 转义，避免标题/描述里的特殊字符破坏标签
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 组装一个最小但完整的分享落地页：OG 标签给爬虫看，meta refresh + JS 给真人跳转
function shareHtml({ title, desc, image, url }) {
  const ogTitle = esc(BRAND + ' · ' + title);
  const ogDesc = esc(desc);
  const ogImage = esc(image);
  const ogUrl = esc(url);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ogTitle}</title>
<meta name="description" content="${ogDesc}">
<meta property="og:title" content="${ogTitle}">
<meta property="og:description" content="${ogDesc}">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${ogUrl}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${ogTitle}">
<meta name="twitter:description" content="${ogDesc}">
<meta name="twitter:image" content="${ogImage}">
<meta http-equiv="refresh" content="0; url=${ogUrl}">
</head>
<body>
<script>try{location.replace(${JSON.stringify(url)});}catch(e){}</script>
<p style="font-family:sans-serif;padding:24px;color:#333">Opening <a href="${ogUrl}">${ogTitle}</a>…</p>
</body>
</html>`;
}

function resp(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function onRequest(context) {
  const { request, env } = context;
  const u = new URL(request.url);
  const c = u.searchParams.get('c') || u.searchParams.get('car') || '';
  const ref = u.searchParams.get('ref') || u.searchParams.get('company') || '';
  const origin = u.origin;

  // 真实用户最终落点：SPA 详情页（带 c）或展厅首页（只带 ref）
  const target = c
    ? `${origin}/?c=${encodeURIComponent(c)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`
    : (ref ? `${origin}/?ref=${encodeURIComponent(ref)}` : `${origin}/`);

  // 首页 / 展厅分享：无具体车，给品牌级 OG 即可
  if (!c) {
    return resp(shareHtml({
      title: BRAND + ' — Ghana Car Export',
      desc: 'Browse quality used cars for export from Ghana. Toyota, Honda, Hyundai and more.',
      image: DEFAULT_OG_IMAGE,
      url: target
    }));
  }

  // 具体车分享：查库补全封面图 + 标题 + 价格
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return resp(shareHtml({ title: BRAND, desc: 'Car for export', image: DEFAULT_OG_IMAGE, url: target }));
  }
  try {
    const client = getSb(env);
    const { data: car } = await client
      .from('cars')
      .select('id, company_id, name, name_zh, price, year, data')
      .eq('id', c)
      .maybeSingle();

    let title = 'Car for export';
    let desc = 'Quality used car for export from Ghana.';
    let image = DEFAULT_OG_IMAGE;

    if (car) {
      const nm = (car.name_zh || car.name || '').toString().trim();
      const yr = car.year || (car.data && car.data.year) || '';
      title = [yr, nm].filter(Boolean).join(' ') || 'Car for export';

      const price = (car.price != null) ? car.price : (car.data && car.data.price);
      const mileage = car.data && car.data.mileage;
      const fuel = car.data && car.data.fuel;
      desc = [price != null ? ('GH₵ ' + Number(price).toLocaleString()) : '',
              mileage ? (mileage + ' km') : '',
              fuel || ''].filter(Boolean).join(' · ') || 'Quality used car for export from Ghana.';

      if (car.company_id) {
        const { data: ph } = await client
          .from('photos')
          .select('data')
          .eq('car_id', c)
          .eq('company_id', car.company_id)
          .order('idx', { ascending: true })
          .limit(1);
        if (ph && ph.length && typeof ph[0].data === 'string' && /^https?:\/\//.test(ph[0].data)) {
          image = ph[0].data;
        }
      }
    }
    return resp(shareHtml({ title, desc, image, url: target }));
  } catch (e) {
    // 任一查询失败都降级为品牌兜底，绝不让分享页白屏
    return resp(shareHtml({ title: BRAND, desc: 'Car for export', image: DEFAULT_OG_IMAGE, url: target }));
  }
}

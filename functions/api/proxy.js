/**
 * Cloudflare Pages Function (Worker API 代理)
 * 路径: /api/proxy
 * 作用：解决部分国内或自定义大模型接口在前端浏览器直接调用时的跨域 (CORS) 限制
 * 免费无服务器函数，Cloudflare 每天提供 100,000 次免费请求
 */

export async function onRequest(context) {
  const { request } = context;

  // 处理 OPTIONS 跨域预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
        'Access-Control-Max-Age': '86400'
      }
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const url = new URL(request.url);
    // 从 query 或 header 获取目标地址
    const targetUrl = url.searchParams.get('url') || request.headers.get('x-target-url');

    if (!targetUrl) {
      return new Response(JSON.stringify({ error: 'Missing target URL parameter (?url=...)' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    const body = await request.text();

    const forwardHeaders = {
      'Content-Type': 'application/json'
    };
    if (authHeader) {
      forwardHeaders['Authorization'] = authHeader;
    }

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: forwardHeaders,
      body: body
    });

    const responseBody = await response.text();

    return new Response(responseBody, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

/**
 * 把本机 /api 请求转到平台根地址。页面本身仍由本机发送，浏览器不跨域。
 * 只转发身份和正文需要的头。平台的 Set-Cookie 不回给浏览器，登录用响应里的 Bearer。
 */

const FORWARD_REQUEST = ['authorization', 'content-type', 'accept', 'x-workspace-id'] as const;

export async function proxyPlatform(baseUrl: string, incoming: Request): Promise<Response> {
  const src = new URL(incoming.url);
  const target = `${baseUrl.replace(/\/+$/, '')}${src.pathname}${src.search}`;
  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const value = incoming.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
  const upstream = await fetch(target, {
    method: incoming.method,
    headers,
    body: hasBody ? incoming.body : undefined,
    redirect: 'manual',
    ...(hasBody ? { duplex: 'half' as const } : {}),
  });
  const out = new Headers();
  const type = upstream.headers.get('content-type');
  if (type) out.set('content-type', type);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

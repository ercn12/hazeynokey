// Tek giriş noktası: /ws/<oda kodu> -> Durable Object, diğer her şey -> statik dosyalar
export { OkeyRoom } from './room.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/ws/')) {
      const code = url.pathname.slice(4).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (!code) return new Response('oda kodu yok', { status: 400 });
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }

    // /yeni -> rastgele oda kodu üret
    if (url.pathname === '/yeni') {
      const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      for (let i = 0; i < 4; i++) code += A[Math.floor(Math.random() * A.length)];
      return Response.json({ code });
    }

    return env.ASSETS.fetch(request);
  }
};

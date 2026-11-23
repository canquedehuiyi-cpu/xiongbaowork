// 待办服务（样例）
Bun.serve({ port: 4321, fetch: () => new Response(Bun.file('index.html')) });

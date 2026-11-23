// 待办服务（样例）：内存里存待办，接口见 TASK.md
const todos = [];
let next = 1;
Bun.serve({
  port: 4321,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/todos' && request.method === 'GET')
      return Response.json(todos);
    if (url.pathname === '/api/todos' && request.method === 'POST') {
      const { text } = await request.json();
      const item = { id: next++, text };
      todos.push(item);
      return Response.json(item, { status: 201 });
    }
    const one = /^\/api\/todos\/(\d+)$/.exec(url.pathname);
    if (one && request.method === 'DELETE') {
      const at = todos.findIndex((todo) => String(todo.id) === one[1]);
      if (at >= 0) todos.splice(at, 1);
      return new Response(null, { status: 204 });
    }
    return new Response(Bun.file('index.html'));
  },
});

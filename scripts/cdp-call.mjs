// Sends one DevTools command to Luma's WebView: cdp-call.mjs METHOD 'JSON params'.
// Uses LUMA_PORT (default 9222). Useful for real touch input, e.g.
//   Input.dispatchTouchEvent '{"type":"touchStart","touchPoints":[{"x":200,"y":300,"id":1}]}'
const port = process.env.LUMA_PORT || 9222;
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const reply = await new Promise(resolve => {
  ws.onmessage = e => { const d = JSON.parse(e.data); if (d.id === 1) resolve(d); };
  ws.send(JSON.stringify({id: 1, method: process.argv[2], params: JSON.parse(process.argv[3] || '{}')}));
});
ws.close();
console.log(JSON.stringify(reply.error || reply.result));

// Evaluates one JS expression in Luma's WebView through the DevTools port that
// scripts/dev.sh forwards to 127.0.0.1:9222. Prints the JSON result.
let page;
for (let i = 0; i < 100 && !page; i++) {
  try {
    const pages = await (await fetch('http://127.0.0.1:' + (process.env.LUMA_PORT || 9222) + '/json')).json();
    page = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
  } catch (_) {}
  if (!page) await new Promise(r => setTimeout(r, 100));
}
if (!page) { console.error('No WebView DevTools page on the forwarded port'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const reply = await new Promise(resolve => {
  ws.onmessage = e => { const d = JSON.parse(e.data); if (d.id === 1) resolve(d); };
  ws.send(JSON.stringify({id: 1, method: 'Runtime.evaluate',
    params: {expression: process.argv[2], awaitPromise: true, returnByValue: true}}));
});
ws.close();
if (reply.error || reply.result.exceptionDetails) {
  console.error(JSON.stringify(reply.error || reply.result.exceptionDetails.exception?.description
    || reply.result.exceptionDetails));
  process.exit(1);
}
console.log(JSON.stringify(reply.result.result.value));

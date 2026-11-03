// Draws one long touch stroke on the preview (for profiling): touch-stroke.mjs X0 Y0 MOVES
const port = process.env.LUMA_PORT || 9222;
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0;
const send = (method, params) => new Promise(r => {
  const n = ++id;
  ws.addEventListener('message', function on(e) { if (JSON.parse(e.data).id === n) { ws.removeEventListener('message', on); r(); } });
  ws.send(JSON.stringify({id: n, method, params}));
});
const [x0, y0, moves] = process.argv.slice(2).map(Number);
await send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: x0, y: y0, id: 1}]});
for (let i = 1; i <= moves; i++) {
  const x = x0 + 120 * Math.sin(i / 9), y = y0 + 80 * Math.cos(i / 13);
  await send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x, y, id: 1}]});
  await new Promise(r => setTimeout(r, 16));
}
await send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
ws.close();

// CPU-profiles the page's JavaScript: js-profile.mjs SECONDS ['JS to run at start']
// Prints the functions with the most self time.
const port = process.env.LUMA_PORT || 9222;
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0;
const send = (method, params = {}) => new Promise(r => {
  const n = ++id;
  ws.addEventListener('message', function on(e) {
    const d = JSON.parse(e.data);
    if (d.id === n) { ws.removeEventListener('message', on); r(d.result); }
  });
  ws.send(JSON.stringify({id: n, method, params}));
});
await send('Profiler.enable');
await send('Profiler.setSamplingInterval', {interval: 200});
await send('Profiler.start');
if (process.argv[3]) await send('Runtime.evaluate', {expression: process.argv[3]});
await new Promise(r => setTimeout(r, +process.argv[2] * 1000));
const {profile} = await send('Profiler.stop');
const self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
const counts = new Map();
for (const s of profile.samples) counts.set(s, (counts.get(s) || 0) + 1);
const total = profile.samples.length;
for (const [nid, c] of counts) {
  const f = byId.get(nid).callFrame;
  const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) || 0) + c);
}
const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 18);
for (const [k, c] of top) console.log((c * 100 / total).toFixed(1).padStart(5) + '%  ' + k);
ws.close();

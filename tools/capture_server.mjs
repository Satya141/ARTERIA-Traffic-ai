// ============================================================================
//  Frame sink for the offline film renderer.
//
//  The browser cannot write to disk, and screen recording gives you whatever
//  frame rate the machine happened to manage. So the film renderer runs on a
//  fixed timestep, encodes each frame itself, and POSTs it here. Rendering can
//  then take as long as it likes — 400 ms a frame if it wants — and the output
//  is still an exact 30 fps sequence.
//
//    node tools/capture_server.mjs
//    POST /begin        clear the frame directory
//    POST /frame?n=123  raw JPEG body -> capture/frames/f00123.jpg
//    POST /end          print the tally
// ============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FRAMES = path.join(ROOT, 'capture', 'frames');
const PORT = 7788;

fs.mkdirSync(FRAMES, { recursive: true });

let written = 0;
let firstAt = 0;

const cors = res => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

const body = req => new Promise((resolve, reject) => {
  const parts = [];
  req.on('data', c => parts.push(c));
  req.on('end', () => resolve(Buffer.concat(parts)));
  req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/begin') {
    for (const f of fs.readdirSync(FRAMES)) {
      if (f.endsWith('.jpg')) fs.unlinkSync(path.join(FRAMES, f));
    }
    written = 0;
    firstAt = Date.now();
    console.log('begin: frame directory cleared');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (url.pathname === '/frame') {
    const n = Number(url.searchParams.get('n') || 0);
    const buf = await body(req);
    if (!buf.length) { res.writeHead(400); return res.end('empty'); }
    fs.writeFileSync(path.join(FRAMES, `f${String(n).padStart(5, '0')}.jpg`), buf);
    written++;
    if (written % 30 === 0) {
      const secs = (Date.now() - firstAt) / 1000;
      process.stdout.write(
        `\r  ${written} frames  (${(written / 30).toFixed(1)}s of video, ` +
        `${(written / Math.max(secs, 0.001)).toFixed(1)} fps render)   `);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (url.pathname === '/end') {
    const secs = (Date.now() - firstAt) / 1000;
    console.log(`\nend: ${written} frames in ${secs.toFixed(1)}s ` +
                `(${(written / 30).toFixed(1)}s of video at 30 fps)`);
    fs.writeFileSync(path.join(ROOT, 'capture', 'frames.json'),
      JSON.stringify({ frames: written, fps: 30, renderSeconds: secs }, null, 2));
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(String(written));
  }

  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, written }));
  }

  res.writeHead(404);
  res.end('no');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`capture sink on http://127.0.0.1:${PORT}  ->  ${FRAMES}`);
});

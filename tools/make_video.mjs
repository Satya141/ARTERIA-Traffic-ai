// ============================================================================
//  Assemble the captured frame sequence into a posting-ready MP4.
//
//    node tools/make_video.mjs
//
//  H.264 High / yuv420p / faststart — what LinkedIn, X and every phone will
//  play without re-encoding. A one-second fade at each end.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FRAMES = path.join(ROOT, 'capture', 'frames');
const OUT = path.join(ROOT, 'capture', 'arteria-demo-1080p.mp4');
const FPS = 30;

const jpgs = fs.existsSync(FRAMES)
  ? fs.readdirSync(FRAMES).filter(f => f.endsWith('.jpg')).sort()
  : [];

if (jpgs.length < FPS) {
  console.error(`only ${jpgs.length} frames in ${FRAMES} — nothing to assemble.`);
  console.error('run the capture first:  node tools/capture_server.mjs  +  open /?film=1');
  process.exit(1);
}

// The sequence is numbered from 0 and must be gapless for the image2 demuxer.
const first = Number(jpgs[0].slice(1, 6));
const last = Number(jpgs[jpgs.length - 1].slice(1, 6));
const missing = (last - first + 1) - jpgs.length;
if (missing > 0) {
  console.error(`WARNING: ${missing} frame(s) missing between f${first} and f${last}.`);
}

const dur = jpgs.length / FPS;
const fadeOutStart = Math.max(0, dur - 1.0).toFixed(3);

const args = [
  '-y',
  '-framerate', String(FPS),
  '-start_number', String(first),
  '-i', path.join(FRAMES, 'f%05d.jpg'),
  '-vf', `fade=t=in:st=0:d=0.8,fade=t=out:st=${fadeOutStart}:d=1.0,format=yuv420p`,
  '-c:v', 'libx264',
  '-profile:v', 'high',
  '-level', '4.1',
  '-preset', 'slow',
  '-crf', '19',
  '-r', String(FPS),
  '-movflags', '+faststart',
  OUT
];

console.log(`assembling ${jpgs.length} frames (${dur.toFixed(1)}s at ${FPS} fps)...`);
const r = spawnSync(ffmpeg, args, { stdio: ['ignore', 'inherit', 'inherit'] });
if (r.status !== 0) process.exit(r.status || 1);

const mb = fs.statSync(OUT).size / 1e6;
console.log(`\n${OUT}`);
console.log(`${dur.toFixed(1)}s  ·  1920x1080  ·  ${FPS} fps  ·  ${mb.toFixed(1)} MB`);

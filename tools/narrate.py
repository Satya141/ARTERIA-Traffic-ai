"""
Voice-over for the demo film.

    python tools/narrate.py                 # synthesise + mux
    python tools/narrate.py --voice en-IN-NeerjaNeural

One line of narration per shot in src/ui/film.js, placed at that shot's start
time. The timings below are the shot durations from the script, so if a shot
length changes there, change it here too.

Each line is synthesised, measured, and re-synthesised faster if it would run
past the end of its own shot — narration that laps into the next caption is the
thing that makes a demo reel feel amateur. The lines are then delayed onto one
timeline (no crossfading, they never overlap), loudness-normalised to -16 LUFS,
which is where social platforms expect speech, and muxed in without touching
the video stream.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'capture')
VO = os.path.join(OUT, 'vo')
FFMPEG = os.path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
if not os.path.exists(FFMPEG):
    FFMPEG = os.path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg')

VOICE = 'en-IN-PrabhatNeural'
for i, a in enumerate(sys.argv):
    if a == '--voice' and i + 1 < len(sys.argv):
        VOICE = sys.argv[i + 1]

# (shot duration, lead-in before the line starts, text)
# Durations must match the `dur` values in script() in src/ui/film.js.
LINES = [
    (5.5, 0.5, "Arteria. Traffic lights that time themselves."),
    (10.0, 0.5, "A traffic light on a timer cannot see the road. It goes green for "
                "empty roads."),
    (9.0, 0.5, "So we put a camera on every road. It counts the vehicles waiting, "
               "ten times a second."),
    (9.5, 0.5, "Green then lasts as long as the queue needs, and ends early when the "
               "road clears."),
    (9.5, 0.5, "Each junction also tells the next one what is coming, and when. So "
               "nobody stops twice."),
    (9.0, 0.5, "Laya makes the choice. An Indian open source model, fine tuned on "
               "this city’s traffic."),
    (8.5, 0.5, "Real time 3D, traffic physics, camera detection, and a fine tuned "
               "model."),
    (8.5, 0.5, "Raise the traffic. Arteria keeps clearing. The timer copy beside it "
               "jams."),
    (10.0, 0.5, "A stadium empties, and everyone goes one way at once. The timer "
                "keeps serving roads that have just gone quiet."),
    (9.5, 0.5, "But the cameras see it. Green time shifts to the loaded roads, "
               "and the queue drains."),
    (10.0, 0.5, "Same traffic, same minute, both networks. About thirty seconds of "
                "waiting, instead of sixty."),
    (6.0, 0.2, "Arteria. Built with WebGL, and a fine tuned Laya engine."),
]


def starts():
    t, out = 0.0, []
    for dur, lead, _ in LINES:
        out.append(t + lead)
        t += dur
    return out, t


def duration(path):
    """Seconds, read back out of ffmpeg's own report."""
    p = subprocess.run([FFMPEG, '-i', path], capture_output=True, text=True)
    m = re.search(r'Duration: (\d+):(\d+):(\d+\.\d+)', p.stderr)
    if not m:
        raise RuntimeError('no duration for ' + path)
    h, mi, s = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(s)


async def synth(text, path, rate):
    import edge_tts
    tag = f'+{rate}%' if rate >= 0 else f'{rate}%'
    await edge_tts.Communicate(text, VOICE, rate=tag).save(path)


def main():
    os.makedirs(VO, exist_ok=True)
    st, total = starts()
    print(f'voice: {VOICE}   timeline: {total:.1f}s')

    files = []
    for i, (dur, lead, text) in enumerate(LINES):
        # Leave a beat before the shot changes. The last line is the exception:
        # there is no next caption for it to tread on, so it may use the shot.
        tail = 0.0 if i == len(LINES) - 1 else 0.25
        budget = dur - lead - tail
        path = os.path.join(VO, f'line_{i:02d}.mp3')
        rate = 0
        for _ in range(5):
            asyncio.run(synth(text, path, rate))
            got = duration(path)
            if got <= budget:
                break
            # Too long for its shot. Nudge the rate, but only a little: past
            # about +12% the voice stops sounding brisk and starts sounding
            # panicked, and the right fix is a shorter line, not a faster one.
            rate += 4
        flag = '' if got <= budget else '  <-- still over, will clip into next shot'
        print(f'  {i:2d}  start {st[i]:5.1f}s  {got:4.1f}s / {budget:4.1f}s  rate {rate:+d}%{flag}')
        files.append(path)

    # --- one timeline -----------------------------------------------------
    args = [FFMPEG, '-y', '-v', 'error', '-stats']
    for f in files:
        args += ['-i', f]
    chains = []
    for i in range(len(files)):
        ms = int(round(st[i] * 1000))
        chains.append(f'[{i}:a]adelay={ms}:all=1[d{i}]')
    mixed = ''.join(f'[d{i}]' for i in range(len(files)))
    # normalize=0 keeps each line at full level; they never overlap anyway
    chains.append(f'{mixed}amix=inputs={len(files)}:normalize=0:dropout_transition=0[m]')
    chains.append('[m]loudnorm=I=-16:TP=-1.5:LRA=11,apad[out]')
    track = os.path.join(OUT, 'narration.wav')
    args += ['-filter_complex', ';'.join(chains), '-map', '[out]',
             '-t', f'{total:.3f}', '-ar', '48000', '-ac', '2', track]
    subprocess.run(args, check=True)
    print(f'\nnarration track: {track}  ({duration(track):.1f}s)')

    # --- mux, without re-encoding the picture -----------------------------
    for src, dst in (('arteria-demo-1080p.mp4', 'arteria-demo-1080p-vo.mp4'),
                     ('arteria-demo-linkedin.mp4', 'arteria-demo-linkedin-vo.mp4')):
        s = os.path.join(OUT, src)
        if not os.path.exists(s):
            continue
        d = os.path.join(OUT, dst)
        subprocess.run([FFMPEG, '-y', '-v', 'error', '-i', s, '-i', track,
                        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
                        '-movflags', '+faststart', '-shortest', d], check=True)
        print(f'{d}   {os.path.getsize(d)/1e6:.1f} MB')


if __name__ == '__main__':
    main()

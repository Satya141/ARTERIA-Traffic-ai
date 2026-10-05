# ARTERIA — AI traffic signal control

A working simulation of six signalised junctions that **count vehicles with cameras,
decide their own green times, and tell the next signal what is coming** — running
side by side against a conventional fixed-timer plan on exactly the same traffic,
in a real-time 3D city.

The city is **HITEC City, Hyderabad**: the junctions carry the names they have on
the ground — Kothaguda, Cyber Towers, Mindspace, Botanical Garden, Shilpa Layout
and Durgam Cheruvu — and the blocks around them carry Cyber Towers, the IT-park
slabs, a mall, and Durgam Cheruvu with its cable-stayed bridge.

[![licence: MIT](https://img.shields.io/badge/licence-MIT-informational)](LICENSE)
[![demo video](https://img.shields.io/badge/demo-1%3A44%20video-crimson)](https://github.com/Satya141/ARTERIA-Traffic-ai/releases/latest)
[![1-minute cut](https://img.shields.io/badge/demo-1%3A00%20cut-crimson)](https://github.com/Satya141/ARTERIA-Traffic-ai/releases/download/v1.0.0/ARTERIA-demo-1min.mp4)

**▶ [Watch the 1:44 demo](https://github.com/Satya141/ARTERIA-Traffic-ai/releases/latest)** —
problem, the three things that fix it, the decision model, the stack, and the
result. Every figure on screen is read live out of the running simulation.

**▶ [Watch the 1-minute cut](https://github.com/Satya141/ARTERIA-Traffic-ai/releases/download/v1.0.0/ARTERIA-demo-1min.mp4)** —
the same story, narrated, for a feed: clean shots of the city and the approach
cameras, with the results from the tables below.

---

## The problem

Most traffic signals in the world run a **fixed timer**. The north road gets 16
seconds, the east road gets 24, round and round, whether there are thirty vehicles
waiting or none at all.

The waste is easy to measure and hard to look at once you have: in these
simulations a well-tuned fixed plan shows **29–55% of its green time to a road
with nobody on it**. Every one of those seconds is a second the other three roads
sat at red for no reason.

## What this does about it

**1. It looks before it decides.**
Every approach has a camera. Ten times a second the detector returns the vehicles
it can see, what class they are, whether they are moving, and how long they have
been there. The controller sizes the green from that: startup loss, plus the
measured queue divided by lanes times the saturation headway.

**2. It stops early when the road empties.**
The moment the queue clears and no vehicle is within 2.6 seconds of the stop line,
the green ends and the time goes to a road that is still waiting. Approaches with
nothing on them are skipped entirely rather than served out of habit.

**3. Junctions warn each other.**
When a junction releases a queue along the main road, it broadcasts an advisory to
the neighbour that traffic is heading for: *how many vehicles, arriving in how
long.* The receiving junction folds that into its own decision and can bring its
green forward, or hold the one it has, so the group meets a green instead of a red.

**4. It gets out of the way of an ambulance.**
A detected emergency vehicle preempts everything at the junctions on its path.

---

## Results

Both worlds run simultaneously from one shared arrival schedule, so the same
vehicle, with the same driver, arrives at the same second in both. 15 simulated
minutes per profile, measured over the whole network.

| Traffic level | Waiting — AI | Waiting — fixed timers | Change |
|---|---|---|---|
| Quiet        | **28.7 s** | 71.4 s  | **−60%** |
| Normal       | **41.2 s** | 78.1 s  | **−47%** |
| Rush hour    | **59.9 s** | 101.5 s | **−41%** |
| Event rush   | **73.2 s** | 136.9 s | **−47%** |

| | AI | Fixed timers |
|---|---|---|
| Green shown to an empty road (rush hour) | **15.7%** | 29.7% |
| Time to cross the area (rush hour) | **135 s** | 168 s |
| Vehicles cleared per hour (rush hour) | **5,070** | 4,500 |

The traffic is an Indian urban mix — 36% two-wheelers, 16% auto-rickshaws, 36%
cars, the rest buses and trucks. That is not decoration: a stream made mostly of
motorcycles has a very different saturation flow and queue length from one made
of cars, and it is what the controller is measuring.

Waiting time counts **every** vehicle — those that finished their trip, those
still on the network, and those still queued outside the model boundary because
the network was too full to admit them. Leaving that last group out is the easiest
way to flatter a failing network, since it lets a controller look good by simply
turning traffic away at the edge.

### An honest note on the signal-to-signal coordination

The messaging layer works — junctions do advertise their platoons, downstream
junctions do act on them, and you can watch both happen — but measured across
the network its effect is **marginal and inconsistent**. Over 15-minute runs it
improves delay at normal and event-rush demand, costs a little at rush hour, and
does nothing at all in light traffic. The share of vehicle groups arriving to
find a green moves by a few points either way depending on the profile.

That is the honest result, and the reason is structural. These junctions serve **one approach at a time**, so the main
road only ever holds green for about a quarter of the cycle — there is not enough
green in the cycle to carry a wave without starving the side roads. Pushed harder,
coordination buys progression for the main road by charging the side roads more
than it saves; a parameter sweep over the weights showed every aggressive setting
costing 4–7% more delay across the network.

So the system **arms coordination only where it can pay** — at junctions where
the main road both dominates the demand and carries real volume — and leaves it
off everywhere else, which is what keeps it from doing net harm. The toggle in
the interface turns it off entirely if you want to see the difference for
yourself, and the ablation script in the repo reproduces the table above.

That conclusion came out of the measurements, not the plan. The first version of
this feature made the network measurably worse, which is only visible because the
platoon-meets-green rate is instrumented directly instead of being assumed.

---

## Laya: the decision engine

Every discrete decision a signal controller makes is a **typed question**:

| Decision | Question type |
|---|---|
| Which road gets the green next? | `choice` over north / east / south / west |
| Should this green be held a little longer? | `noul` — yes/no with a probability |
| Does an emergency need priority right now? | `noul` |
| How badly is traffic building up here? | `score` — light / building / heavy |

[Laya](https://github.com/NandhaKishorM/laya) answers exactly that shape: a
non-autoregressive System 1 decision engine that returns typed answers with
calibrated probabilities in a single forward pass — ~33 ms, no generated text to
parse. So instead of scoring phases against hand-tuned weights, ARTERIA writes
out what the cameras saw in plain language and asks:

```
Junction Cyber Towers, HITEC City. One road at a time may have a green light.
north road: 8 vehicles waiting, longest wait 34 seconds, 3 more approaching.
east road: 2 vehicles waiting, longest wait 6 seconds, 5 more approaching,
  it has the green now and has had it for 12 seconds.
south road: 11 vehicles waiting, longest wait 61 seconds, 1 more approaching.
An ambulance is waiting on the south road.
Kothaguda reports 7 vehicles arriving on the west road in about 9 seconds.
```

…and applies the answers. All six junctions go out in one batched call.

**Run it:**

```bash
pip install -r server/requirements.txt
python server/laya_service.py
```

### The base checkpoint cannot do this job, and that is the interesting part

Measured before anything else was built on top of it, the shipped checkpoint —
which has never seen a traffic decision — answers this domain at close to chance.
Four unambiguous probes, one road swamped and the rest empty:

```
south swamped (18 waiting, 90s)   -> answered west   p=0.85   MISS
north swamped (22 waiting)        -> answered west   p=0.55   MISS
west  swamped (19 waiting)        -> answered west   p=0.45   OK
east  swamped (17 waiting, 80s)   -> answered west   p=0.60   MISS
                                                     1/4 correct
```

It names the same road regardless of the state. That is consistent with Laya's
own published figure: **0.362 accuracy zero-shot against 0.766 fine-tuned** on
its typed-decisions benchmark. The runtime also warns that this checkpoint ships
uncalibrated temperatures.

Speed had the same problem until the GPU was set up:

| | single decision | six junctions, batched |
|---|---|---|
| CPU (torch 2.14) | 3,600–4,500 ms | 2,912 ms per junction |
| GPU (RTX 5050, cu128) | **61 ms** | **43 ms per junction** |

So the integration ships with two safeguards and one fix.

**Safeguard 1 — a supervisory check.** The model proposes, the detectors dispose.
Laya's chosen road is compared against measured demand and rejected if it names a
road carrying less than 45% of the strongest claim at that junction. A bad answer
cannot degrade the network; it falls back and the rejection is counted.

**Safeguard 2 — the timing stays in code.** Laya decides *which* road and
*whether* to hold. Minimum green, the amber and all-red clearance, and the
starvation cap are not negotiable by a model.

**The fix — fine-tune it on this domain.**

```bash
node tools/make_dataset.mjs 3000        # 12,005 labelled decisions
python server/finetune_traffic.py       # needs a CUDA GPU
python server/eval_traffic.py           # fine-tuned vs base, held-out split
```

The dataset is the reason this is tractable. The simulator knows things the
controller does not: the controller sees a 95 m camera range with a per-frame
miss rate and positional jitter, while the simulator knows every vehicle on the
approach and exactly how long each has waited. So each row pairs **the noisy
camera description** — byte-identical to what the live client sends, because it
is produced by the same code — with **a label computed from ground truth**. The
model learns to infer the true state of a junction from an imperfect description
of it, which is the actual job.

Labels are soft probability distributions, so a genuinely close call trains as a
close call. Answers are quota-balanced across the four roads per demand profile,
which directly targets the degenerate always-one-road failure above.

Training follows Laya's own recipe (RLCD: GRPO against a strictly proper scoring
rule plus soft cross-entropy), adapted from their two-T4 notebook to a single
local GPU. The adaptation that mattered was memory: the full model spilled an
8.46 GB peak onto an 8.15 GB card in every configuration, which dragged the run
to 1.7 seq/s and an eleven-hour estimate. Freezing the embeddings and the bottom
20 encoder layers took it to 38-44 seq/s and the whole run to **32 minutes**.

**Result on the 1,201-case held-out split:**

| | base checkpoint | fine-tuned | |
|---|---:|---:|---|
| road choice (4-way, chance 25%) | 24.9% | **72.6%** | +47.7 pts |
| hold-or-switch accuracy | 51.4% | **89.6%** | +38.2 pts |
| pressure, mean absolute error | 0.60 | **0.35** | levels of 0-2 |
| Brier score (calibration) | 0.126 | **0.025** | lower is better |

The degenerate always-one-road answer is gone: the base checkpoint named `west`
on essentially every case, the fine-tuned one distributes across all four.

**Closed-loop, which is the number that counts.** `tools/bench_laya.mjs` runs
fixed-time, heuristic and Laya worlds on one shared arrival schedule:

| | fixed-time | Laya | vs fixed | heuristic |
|---|---:|---:|---:|---:|
| normal flow, mean delay | 56.0 s | 31.2 s | **-44.3%** | 27.9 s |
| peak, mean delay | 51.4 s | 28.4 s | **-44.8%** | 28.6 s |

So: a large, real win over fixed timers, and a **tie with the hand-written
heuristic** — Laya matches it at peak and is 11.6% behind it at normal flow.

That gap is a labelling artefact, not a model failure, and it is worth stating
plainly. The oracle that produced the training labels uses a *greedy*
highest-pressure rule. The heuristic it is being compared against is strictly
richer: it also does gap-out, phase skipping, starvation caps, a downstream
occupancy penalty and V2I holds. The model learned the policy it was shown, and
that policy is simpler than its competition. Relabelling from the tuned
controller's own decisions is the obvious next step. Epoch 2 also added nothing
(average loss 0.502 -> 0.539), so one epoch on better labels is the experiment.

The pill in the top bar tells you which engine is actually deciding —
`DECIDING · 31ms` when Laya is live, `OFFLINE · FALLBACK` when it is not — and
the control-room feed shows the decision records: the question, the answer, and
its probability.

**What stays in code, deliberately.** Laya decides *which* road and *whether* to
hold. The safety timing around it — minimum green, the amber and all-red
clearance, the starvation cap that stops any approach being ignored — stays in
the controller, because a decision engine should not be able to skip an all-red.

**The sidecar is optional.** Without it `available` stays false and every
junction uses the built-in heuristic, so `npm run dev` on its own still gives
you the whole simulation.

> **On the numbers above:** the benchmark table was measured with the
> deterministic heuristic, so the ablation script reproduces it exactly. Running
> with Laya in the loop will give different figures — the live comparison in the
> interface is computed from whichever engine is actually driving, so what you
> see on screen is always the real result for that run.

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:5173. Build for deployment with `npm run build`; the
output in `dist/` is a static site that runs anywhere.

**Using the interface**

- **Click any junction**, in the 3D view or the list on the right, to open it. The
  panel shows all four roads: which is green, how long it has left, how long the
  others must wait, how many vehicles are queued, and the **live camera feed from
  each approach** with the detector's boxes drawn on it.
- The **messages panel** is the signal-to-signal traffic, in plain words.
- **HOW BUSY** changes the demand. *Event rush* is the interesting one: a sharply
  one-directional load, the case a fixed plan cannot see coming.
- **VIEW** cycles whole city → main road → this junction → riding along with a car.

---

## Making the demo video

```bash
node tools/capture_server.mjs               # frame sink, port 7788
# then open http://localhost:5173/?film=1   and leave it alone
node tools/make_video.mjs                   # -> capture/arteria-demo-1080p.mp4
```

Then add the voice-over:

```bash
python tools/narrate.py                     # -> capture/arteria-demo-*-vo.mp4
python tools/narrate.py --voice en-IN-NeerjaNeural
```

This renders a 93-second 1920x1080 explainer **offline, frame by frame**, rather
than screen-recording the tab. The cut runs problem -> the three things that fix
it -> the decision model -> the stack -> proof, and every figure on screen is
read live out of the running simulation, including the fixed-time twin's own
wasted-green percentage in the opening beat.

Narration is one line per shot, synthesised with `edge-tts`, placed at that
shot's start and normalised to -16 LUFS. Lines that would run past the end of
their own shot are nudged faster, but only in 4% steps and only so far: past
about +12% the voice stops sounding brisk and starts sounding panicked, and the
right fix is a shorter line, not a faster one.

The distinction matters. A `MediaRecorder` on a display stream captures whatever
frame rate the machine managed at that instant, and a GTAO pass plus a bloom
chain plus four extra scene renders for the approach cameras does not hold 60
fps — so the result stutters in exactly the shots worth watching. Here the clock
is the frame counter. Each frame advances the simulation by precisely 1/30 s, is
rendered at full quality for however long that takes, is JPEG-encoded and posted
to a small local sink that writes it to disk. ffmpeg then assembles an exact
30 fps sequence. About ten minutes to produce, perfectly smooth to watch.

Two things worth knowing if you touch this:

- **Use `toDataURL`, not `toBlob`.** `toBlob` hands the encode to another thread
  and returns through the task queue; measured on this machine that is 1030 ms a
  frame against 20 ms for the synchronous call. Over 2,730 frames it is the
  difference between six minutes and an hour.
- **The overlay is not the app's interface.** `src/ui/film.js` draws a second,
  much larger set of the same live numbers straight into the frame. The app's
  panels are sized for someone at a desk; in a phone-sized feed they are
  illegible. Everything in them is read live from the running simulation — the
  A/B delay figures, the wasted-green split, Laya's decision records with their
  probabilities, and the messages the junctions send each other.

`?film=1&probe=1` renders one representative frame per shot instead of the whole
sequence, which is how you check the layout without waiting ten minutes for it.

There is also a **RECORD DEMO** button in the interface, which screen-records a
shorter scripted tour to `.webm`. It is quicker and it stutters; the offline
route above is the one to post.

## How it is built

No game engine, no external assets, no backend. Vanilla JavaScript, Three.js for
rendering, Vite to build. Every texture — road surface, lane markings, crosswalks,
building facades with their lit windows — is drawn into a canvas at load time.

```
src/
  core/config.js      every tunable constant in one place
  core/rng.js         seeded PRNG, so both worlds get identical traffic
  sim/network.js      road graph: junctions, links, lanes, turn geometry
  sim/vehicle.js      car-following (IDM), lane changes, junction traversal
  sim/demand.js       shared arrival schedule and demand profiles
  sim/simulation.js   the world, stepped at a fixed 30 Hz
  ai/vision.js        per-approach detection, with realistic detector error
  ai/controller.js    the adaptive controller
  ai/coordinator.js   junction-to-junction messaging
  ai/fixedtime.js     the fixed-timer baseline
  ai/metrics.js       measurement, shared by both worlds
  render/             city, vehicles, signals, lighting, post-processing
  ui/                 interface and the camera feeds
```

### Things worth knowing

**The traffic model is microscopic, not statistical.** Every vehicle is an agent
following the Intelligent Driver Model, choosing lanes, holding gaps, and refusing
to enter a junction when the road beyond it is full — which is what stops a
congested network from driving into its own gridlock.

**The detector is deliberately imperfect.** Detections carry a per-frame miss rate,
positional jitter, and distance-dependent confidence. The controller never reads
the simulation's ground truth; it only ever sees what the cameras report, which is
the situation it would be in on real hardware.

**The baseline is not a strawman.** The fixed plan gets sensible splits
proportional to design flow, and per-junction offsets that happen to coordinate the
corridor well — it achieves a **57% platoon-meets-green rate, far better than the
adaptive controller manages.** That is the honest picture: a fixed plan is
genuinely good at progression on the day it was tuned for. It just cannot respond
to anything else, which is where all 41–57% of the delay saving comes from.

**Nothing in the scene is a downloaded asset.** Every road surface, lane marking,
crosswalk, masonry facade and glass curtain wall is drawn into a canvas at load
time. Vehicles are assembled from primitives and merged per class; every piece of
street furniture in the city — columns, railings, bollards, shelters, benches,
signs, trees, rooftop plant — is merged into one batch; buildings are merged per
facade. The whole scene is about 120 draw calls, which is what makes it
affordable to render five times a frame (the main view plus four approach
cameras).

**Three things do most of the work visually.** The sky shader is baked into a
reflection probe at startup, so car paint gets a clearcoat highlight and glass
towers mirror the sky — without it, metal and glass have nothing to reflect and
render flat. Ambient occlusion darkens contact points, which is the difference
between objects sitting on the road and objects pasted onto it. And the shadow
camera is kept tight and follows the view target, because one stretched over the
whole network gives half a metre per texel and turns every car's shadow into a
blob.

**The four camera views are real renders.** Each is the scene drawn again from a
camera on that approach's mast arm, composited into the page through the
renderer's scissor rectangle — not a video, and not a diagram.

---

## Where this would go next

- Learn the controller's weights with reinforcement learning rather than hand-tuning
  them, and compare against this hand-tuned baseline.
- Pedestrian phases and demand, which change the fairness calculation considerably.
- Swap the simulated detector for a real YOLO model over a traffic camera feed; the
  controller's input format is already the same shape.
- Public-transport priority — buses are already weighted more heavily in the demand
  score, but they get no dedicated phase.

---

Built as a study of how much delay is sitting inside ordinary fixed-time signal
plans, and how much of it a camera and a decent decision rule can take back.

---

## Credits

Built by **Satyanarayana Javvadi** ([@Satya141](https://github.com/Satya141)).
Claude (Anthropic) paired on the Laya fine-tuning pipeline, the offline film
renderer and the documentation.

---

## Licence

This project is released under the [MIT Licence](LICENSE).

It builds on work released by others:

| | licence | how it is used |
|---|---|---|
| [Laya](https://github.com/NandhaKishorM/laya) — Convai Innovations | Apache-2.0 | the decision engine, installed from PyPI |
| [Three.js](https://github.com/mrdoob/three.js) | MIT | rendering |
| [Vite](https://github.com/vitejs/vite) | MIT | build |
| PyTorch, Transformers | BSD-3 / Apache-2.0 | the fine-tune |

None of these are vendored into this repository — they install from npm and
PyPI — so the MIT licence above covers this project's own source only.

One thing to note if you build on the fine-tuning side of this: the checkpoint
produced by `server/finetune_traffic.py` is a **derivative of Laya's
Apache-2.0 base checkpoint**. It is not distributed here (`models/` is
git-ignored, and the pipeline rebuilds it in about 32 minutes). If you publish
your own trained weights, Apache-2.0 asks you to carry its licence text with
them and to state what you changed.

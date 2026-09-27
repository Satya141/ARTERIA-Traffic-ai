// ============================================================================
//  ARTERIA — global tuning constants
//  Everything that a traffic engineer would want to tweak lives here.
// ============================================================================

export const CFG = {
  // ---------- network geometry (metres) ----------
  // 230 m between junctions is a realistic urban arterial spacing, and it is
  // also what makes corridor coordination physically possible: a platoon takes
  // ~16 s to travel a block, which is long enough for the downstream junction
  // to finish a minimum green and change over before the platoon arrives.
  grid: { cols: 3, rows: 2, spacing: 230 },
  laneWidth: 3.6,
  // lane 0 is a dedicated left-turn pocket, lanes 1..n-1 are through/right.
  // That mirrors how real arterials are striped and — crucially — lets the
  // per-lane detectors attribute demand to the correct phase.
  lanesPerDir: 3,
  laneChange: { minDist: 16, maxDist: 135, easeTime: 0.85 },
  terminalOffset: 165,          // how far boundary sources sit beyond the edge
  stopLineSetback: 2.0,

  // ---------- vehicle dynamics (IDM) ----------
  idm: {
    aMax: 2.1,                  // comfortable acceleration  m/s²
    bComf: 2.8,                 // comfortable deceleration  m/s²
    bMax: 7.0,                  // emergency deceleration    m/s²
    s0: 2.2,                    // minimum bumper gap        m
    T: 1.15,                    // desired time headway      s
    delta: 4
  },
  speedLimit: 16.6,             // ~60 km/h arterial free-flow
  turnSpeed: { through: 13.0, right: 6.5, left: 7.5 },
  yellowDecelThreshold: 4.5,    // can't stop harder than this => run the yellow

  // ---------- signal timing ----------
  signal: {
    minGreen: 9,
    maxGreen: 55,
    yellow: 3.0,
    allRed: 1.6,
    startupLoss: 2.0,           // lost time before the queue starts discharging
    satHeadway: 2.05,           // saturation headway per lane   s/veh
    gapOut: 2.6,                // terminate green if no arrival within this gap
    starvationLimit: 95         // hard fairness cap on any approach's wait  s
  },

  // fixed-time baseline (what most Indian/global junctions actually run)
  // per-approach splits N, E, S, W - the arterial legs get the longer greens
  fixedTime: { splits: [16, 24, 16, 24] },

  // ---------- perception ----------
  vision: {
    range: 95,                  // how far up the approach each camera sees  m
    // Vertical field of view of the mast-arm camera. A real enforcement /
    // Framing of the mast-arm camera. A wide, level lens is wrong twice over:
    // it puts the horizon across the middle of the picture, and it takes in the
    // opposing carriageway across the centre line, so one camera looks like two
    // stitched together. A real detection camera is a longish lens mounted over
    // the far side of the junction, aimed back along its OWN approach.
    //
    // Framing is derived, not eyeballed. With the camera h above the road and
    // the lens aimed at a point d upstream, pitch = atan(h / d); the frame then
    // runs from h/tan(pitch + fov/2) to h/tan(pitch - fov/2) along the road.
    // These values put the stop line on the bottom edge, keep the horizon just
    // out of the top edge, and make the frame about 15 m wide at the aim point
    // so the approach's own three lanes fill it and the opposing carriageway
    // stays out of shot.
    fovDeg: 14,                 // vertical field of view
    mountHeight: 5.6,           // m above the carriageway
    standOff: 20,               // m beyond the stop line the camera is mounted
    aimDistance: 15,            // m upstream of the stop line the lens points at
    // Aimed a little kerbside of its own lane centre. Dead centre leaves a
    // couple of metres of the opposing carriageway at the frame edge, which is
    // invisible while those lanes are held at red and then reads as a second
    // road spliced into the picture the moment they get their green.
    aimOffset: 3.0,
    confidenceFloor: 0.58,
    missRate: 0.035,            // detector false-negative rate per frame
    jitter: 0.9,                // positional noise on detections  m
    hz: 10                      // inference rate
  },

  // ---------- adaptive controller weights ----------
  control: {
    wQueue: 1.0,
    wArrival: 0.55,             // vehicles approaching but not yet stopped
    wWait: 0.030,               // per second of accumulated wait
    wDownstream: 0.45,          // max-pressure: subtract downstream occupancy
    wCoord: 1.05,                // V2I green-wave bonus
    emergencyWeight: 60,
    // A phase change costs yellow + all-red of dead time. The challenger must
    // beat the incumbent by enough to pay for that, otherwise the junction
    // ping-pongs and every driver eats an extra stop.
    switchMargin: 7.5,
    skipThreshold: 0.45,        // demand below this: skip the phase entirely
    // A decision engine's choice is accepted only if the road it names carries
    // at least this share of the strongest claim at the junction.
    layaMinShare: 0.45
  },

  // ---------- V2I corridor coordination ----------
  coord: {
    horizon: 24,                // how far ahead platoon ETAs are broadcast  s
    lead: 3.0,
    minPlatoon: 2,
    holdMax: 12,                 // max extra green spent holding for a platoon s
    // Delay a vehicle avoids by arriving on green instead of stopping: the
    // startup loss plus roughly half a red. This is the currency the hold
    // decision is settled in — veh-seconds saved against veh-seconds imposed.
    stopPenalty: 6.5,
    // Arming gate. Measured over many runs, holding or advancing a green for a
    // platoon is a win only where the corridor genuinely dominates AND carries
    // real volume. Below these thresholds it buys progression for the main road
    // by charging the side roads more than it saves, so it simply does not arm.
    arterialShare: 0.62,
    demandFloor: 24.0
  },

  // ---------- demand ----------
  demand: {
    baseVph: 285,               // per entry point, scaled by profile
    arterialBias: 1.55,
    turnSplit: { through: 0.60, right: 0.21, left: 0.19 },
    emergencyEveryS: 115
  },

  // ---------- vehicle classes ----------
  //  The `share` figures are an Indian urban arterial mix: two-wheelers are the
  //  single largest group by a wide margin, auto-rickshaws are next, and cars
  //  are a minority. This is not cosmetic — a stream made mostly of motorcycles
  //  has a very different saturation flow and queue length from one made of
  //  cars, which is exactly what the controller is measuring.
  classes: {
    hatchback: { w: 1.72, l: 3.85, h: 1.50, weight: 1.0,  pce: 1.0,  share: 0.2, vmax: 1.02 },
    sedan:     { w: 1.80, l: 4.55, h: 1.46, weight: 1.0,  pce: 1.0,  share: 0.11, vmax: 1.05 },
    suv:       { w: 1.92, l: 4.75, h: 1.78, weight: 1.1,  pce: 1.2,  share: 0.05, vmax: 1.00 },
    auto:      { w: 1.40, l: 2.70, h: 1.75, weight: 0.7,  pce: 0.8,  share: 0.16, vmax: 0.62 },
    bike:      { w: 0.80, l: 2.00, h: 1.35, weight: 0.45, pce: 0.4,  share: 0.36, vmax: 0.88 },
    bus:       { w: 2.55, l: 11.0, h: 3.20, weight: 3.4,  pce: 3.0,  share: 0.06, vmax: 0.72 },
    truck:     { w: 2.45, l: 8.60, h: 3.05, weight: 2.2,  pce: 2.5,  share: 0.06, vmax: 0.68 },
    ambulance: { w: 2.10, l: 5.90, h: 2.55, weight: 1.6,  pce: 1.8,  share: 0.00, vmax: 1.10 }
  },

  // ---------- environment model ----------
  emissions: {
    idleGramsPerSec: 1.62,      // CO2 while stationary, engine on
    cruiseGramsPerSec: 2.35,
    fuelIdleMlPerSec: 0.31
  },

  sim: { dt: 1 / 30, maxSpeedMultiplier: 8 }
};

// ---------------------------------------------------------------------------
//  Phasing: ONE APPROACH AT A TIME.
//
//  Each phase gives a single approach a full green for all of its movements —
//  through, left and right — while the other three legs hold red. This is the
//  staging used at most Indian signalised junctions, and it has two properties
//  that matter here: it is conflict-free by construction (nothing else is
//  moving, so no turn can ever cross another vehicle's path), and it is
//  unambiguous to read — exactly one green face per junction at any moment.
// ---------------------------------------------------------------------------
const ALL_TURNS = ['through', 'right', 'left'];
export const PHASES = [
  { id: 0, key: 'N', label: 'NORTHBOUND', axis: 'NS', heads: ['N'], turns: ALL_TURNS },
  { id: 1, key: 'E', label: 'EASTBOUND',  axis: 'EW', heads: ['E'], turns: ALL_TURNS },
  { id: 2, key: 'S', label: 'SOUTHBOUND', axis: 'NS', heads: ['S'], turns: ALL_TURNS },
  { id: 3, key: 'W', label: 'WESTBOUND',  axis: 'EW', heads: ['W'], turns: ALL_TURNS }
];
export const ARTERIAL_PHASES = [1, 3];      // E and W: the coordinated corridor

export const HEADINGS = {
  N: { x: 0, z: -1 },
  S: { x: 0, z: 1 },
  E: { x: 1, z: 0 },
  W: { x: -1, z: 0 }
};

// right-hand-side lateral vector for a heading  r = (-fz, fx)
export const RIGHT_OF = { N: 'E', E: 'S', S: 'W', W: 'N' };
export const LEFT_OF  = { N: 'W', W: 'S', S: 'E', E: 'N' };
export const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };

export const HALF_ROAD = CFG.lanesPerDir * CFG.laneWidth;   // centreline -> kerb
export const JUNCTION_HALF = HALF_ROAD + 1.0;

// Offline film renderer (`?film=1`). Compositing the WebGL canvas into a 2D
// canvas needs the drawing buffer to survive past the render call, which costs
// a little performance, so it is only asked for when actually filming.
export const FILM = typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('film');

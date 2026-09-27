import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FILM } from '../core/config.js';

// ============================================================================
//  Renderer, camera rig, sky and lighting — including a full day/night cycle
//  that drives sun colour, fog, street lighting and window emission.
// ============================================================================

const SKY_VERT = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */`
  varying vec3 vWorld;
  uniform vec3 uTop, uMid, uBottom, uSunDir, uSunColor;
  uniform float uSunIntensity;
  void main() {
    vec3 dir = normalize(vWorld);
    float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uBottom, uMid, smoothstep(0.34, 0.52, h));
    col = mix(col, uTop, smoothstep(0.5, 0.95, h));
    float sun = pow(max(dot(dir, normalize(uSunDir)), 0.0), 220.0);
    float halo = pow(max(dot(dir, normalize(uSunDir)), 0.0), 7.0) * 0.28;
    col += uSunColor * (sun * 6.0 + halo) * uSunIntensity;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// keyframes of the day, interpolated by hour
const SKY_KEYS = [
  { h: 0,  top: 0x05070f, mid: 0x0a1020, bot: 0x121a2b, sun: 0x2b3a5c, amb: 0x1b2440, int: 0.05, fog: 0x0a0f1a, fogD: 0.00082 },
  { h: 5.5,top: 0x121a33, mid: 0x3a3352, bot: 0x8a5a55, sun: 0xff8a55, amb: 0x3d3a55, int: 0.35, fog: 0x2a2436, fogD: 0.00095 },
  { h: 7,  top: 0x2f5c9e, mid: 0x7fa5cc, bot: 0xf0b183, sun: 0xffb070, amb: 0x6a7a99, int: 0.85, fog: 0x94a6bf, fogD: 0.00068 },
  { h: 12, top: 0x2b6fc4, mid: 0x86b4e0, bot: 0xd8e6f2, sun: 0xfff4e2, amb: 0x9fb6cc, int: 1.15, fog: 0xbcd0e2, fogD: 0.00017 },
  { h: 17.5,top:0x2d63ae, mid: 0x8fa9cf, bot: 0xe8c39a, sun: 0xffd6a0, amb: 0x93a2bb, int: 1.0,  fog: 0xb2bfd2, fogD: 0.00026 },
  { h: 19.3,top:0x1b2b4d, mid: 0x5c4a68, bot: 0xd97a4a, sun: 0xff7a3c, amb: 0x4e4763, int: 0.45, fog: 0x4a415a, fogD: 0.00088 },
  { h: 21, top: 0x080d1a, mid: 0x111a2e, bot: 0x1b2438, sun: 0x3b4a70, amb: 0x222c48, int: 0.10, fog: 0x101725, fogD: 0.00090 },
  { h: 24, top: 0x05070f, mid: 0x0a1020, bot: 0x121a2b, sun: 0x2b3a5c, amb: 0x1b2440, int: 0.05, fog: 0x0a0f1a, fogD: 0.00082 }
];

function lerpKeys(hour) {
  let a = SKY_KEYS[0], b = SKY_KEYS[SKY_KEYS.length - 1];
  for (let i = 0; i < SKY_KEYS.length - 1; i++) {
    if (hour >= SKY_KEYS[i].h && hour <= SKY_KEYS[i + 1].h) { a = SKY_KEYS[i]; b = SKY_KEYS[i + 1]; break; }
  }
  const t = (hour - a.h) / Math.max(b.h - a.h, 0.0001);
  const mix = (x, y) => new THREE.Color(x).lerp(new THREE.Color(y), t);
  return {
    top: mix(a.top, b.top), mid: mix(a.mid, b.mid), bot: mix(a.bot, b.bot),
    sun: mix(a.sun, b.sun), amb: mix(a.amb, b.amb),
    fog: mix(a.fog, b.fog),
    intensity: a.int + (b.int - a.int) * t,
    fogDensity: a.fogD + (b.fogD - a.fogD) * t
  };
}

export class World {
  constructor(canvas, extent) {
    this.extent = extent;
    this.hour = 18.4;
    this.nightFactor = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, powerPreference: 'high-performance', stencil: false,
      // the film renderer copies this canvas into a 2D compositor after the
      // render call has already returned, so the buffer has to still be there
      preserveDrawingBuffer: FILM
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.85));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x0d1522, 0.0012);

    const span = Math.max(extent.x, extent.z);
    this.camera = new THREE.PerspectiveCamera(46, 1, 1, 6000);
    this.camera.position.set(span * 0.40, span * 0.31, span * 0.58);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.maxPolarAngle = Math.PI * 0.487;
    this.controls.minDistance = 28;
    this.controls.maxDistance = span * 3.1;
    this.controls.target.set(0, 0, 0);

    this.buildSky(span);
    this.buildLights(span);
    this.buildComposer(canvas);

    this.tmpV = new THREE.Vector3();
  }

  buildSky(span) {
    this.skyUniforms = {
      uTop: { value: new THREE.Color(0x2b6fc4) },
      uMid: { value: new THREE.Color(0x86b4e0) },
      uBottom: { value: new THREE.Color(0xd8e6f2) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.5, 0.3) },
      uSunColor: { value: new THREE.Color(0xfff0dd) },
      uSunIntensity: { value: 1 }
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(span * 6, 32, 20),
      new THREE.ShaderMaterial({
        uniforms: this.skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
        side: THREE.BackSide, depthWrite: false, fog: false
      })
    );
    sky.frustumCulled = false;
    this.scene.add(sky);
    this.sky = sky;
  }

  buildLights(span) {
    this.hemi = new THREE.HemisphereLight(0xbcd0e2, 0x2a2f38, 0.65);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff0dd, 2.1);
    this.sun.castShadow = true;
    // A shadow camera stretched over the whole network would give roughly half
    // a metre per texel — cars would cast shapeless blobs. Instead it is kept
    // tight and follows whatever the view is looking at, which is the only part
    // that can be seen closely anyway.
    this.shadowRadius = 165;
    const s = this.shadowRadius;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 1400;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.25;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.ambient = new THREE.AmbientLight(0x404a5c, 0.5);
    this.scene.add(this.ambient);
    this.sunDir = new THREE.Vector3(0.4, 0.6, 0.3).normalize();
  }

  // --------------------------------------------------------------------------
  //  Image-based lighting.
  //
  //  Without an environment, every metal and glass surface in the scene has
  //  nothing to reflect and renders flat and plasticky. This bakes the sky
  //  shader (plus a ground plane, so the lower hemisphere is not sky-blue) into
  //  a prefiltered cubemap, which is what gives car paint its highlight roll-off
  //  and puts a sky reflection in every window.
  // --------------------------------------------------------------------------
  buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();

    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(100, 32, 20),
      new THREE.ShaderMaterial({
        uniforms: this.skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
        side: THREE.BackSide, depthWrite: false, fog: false
      })
    );
    envScene.add(dome);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(100, 40),
      new THREE.MeshBasicMaterial({ color: 0x35393f })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1;
    envScene.add(ground);

    if (this.envRT) this.envRT.dispose();
    this.envRT = pmrem.fromScene(envScene, 0.02);
    this.scene.environment = this.envRT.texture;
    this.builtEnvAt = this.hour;
    pmrem.dispose();
    dome.geometry.dispose();
    ground.geometry.dispose();
  }

  // Keep the shadow volume centred on what the camera is looking at.
  focusShadows(target) {
    const d = this.sunDir;
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
    this.sun.position.set(
      target.x + d.x * 700, target.y + d.y * 700, target.z + d.z * 700);
    this.sun.updateMatrixWorld();
  }

  buildComposer(canvas) {
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    // Ambient occlusion. Direct sunlight plus a sky probe still leaves every
    // crease evenly lit, so kerbs, wheel arches, the undersides of canopies and
    // the join where a building meets the pavement all read as decals. Darkening
    // contact points is the single biggest step from "3D scene" to "photograph".
    this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.updateGtaoMaterial({
      radius: 2.6,            // metres: tuned for kerb and vehicle scale
      distanceExponent: 1.4,
      thickness: 1.4,
      scale: 1.0,
      samples: 12,
      screenSpaceRadius: false
    });
    this.gtao.blendIntensity = 0.85;
    this.composer.addPass(this.gtao);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.62, 0.82);
    this.composer.addPass(this.bloom);

    this.smaa = new SMAAPass(1, 1);
    this.composer.addPass(this.smaa);
    this.composer.addPass(new OutputPass());
  }

  setHour(h) {
    this.hour = ((h % 24) + 24) % 24;
    const k = lerpKeys(this.hour);

    this.skyUniforms.uTop.value.copy(k.top);
    this.skyUniforms.uMid.value.copy(k.mid);
    this.skyUniforms.uBottom.value.copy(k.bot);
    this.skyUniforms.uSunColor.value.copy(k.sun);
    this.skyUniforms.uSunIntensity.value = Math.max(k.intensity, 0.08);

    // sun arcs east -> west, below the horizon at night
    const dayT = (this.hour - 6) / 12;                 // 0 at 06:00, 1 at 18:00
    const elev = Math.sin(dayT * Math.PI);
    const azim = (dayT - 0.5) * Math.PI * 1.05;
    const span = Math.max(this.extent.x, this.extent.z);
    const dir = new THREE.Vector3(Math.sin(azim), Math.max(elev, -0.35), Math.cos(azim) * 0.55).normalize();
    this.skyUniforms.uSunDir.value.copy(dir);
    this.sunDir.copy(dir);
    this.sun.position.copy(dir).multiplyScalar(700);
    this.sun.target.position.set(0, 0, 0);
    this.sun.color.copy(k.sun);
    this.sun.intensity = Math.max(0, elev) * 3.0 + 0.08;
    this.sun.castShadow = elev > 0.06;

    this.hemi.color.copy(k.mid);
    this.hemi.intensity = 0.46 + k.intensity * 0.72;
    this.ambient.color.copy(k.amb);
    this.ambient.intensity = 0.34 + k.intensity * 0.34;

    this.scene.fog.color.copy(k.fog);
    this.scene.fog.density = k.fogDensity;
    this.renderer.setClearColor(k.fog, 1);

    // 0 in full daylight, 1 deep night — drives lamps, windows and bloom
    this.nightFactor = THREE.MathUtils.clamp(1 - (elev + 0.16) / 0.46, 0, 1);
    this.bloom.strength = 0.30 + this.nightFactor * 0.68;
    this.renderer.toneMappingExposure = 1.16 + this.nightFactor * 0.14;
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    if (this.gtao) this.gtao.setSize(w, h);
  }

  render() {
    this.controls.update();
    this.focusShadows(this.controls.target);
    this.composer.render();
  }
}

/*
 * BODY-DRIVEN Speed Map (Yellow → Red) + WebGL Fluid Simulation
 * Idle = bright yellow, Fast = deep red
 * Turbo responsive + optional quick snap-back
 * + Skeleton, Virtual Chest, Facing Arrow
 * + WebGL Fluid dynamics driven by body movement
 * - [D] toggle HUD, [S] toggle skeleton, [F] toggle fluid
 *
 * Requires ml5.js:
 *  - bodyPose('BlazePose') or bodyPose()
 *  - bodySegmentation('SelfieSegmentation', { maskType: 'background' })
 */

let video;
let bodyPose, bodySegmentation;
let poses = [];
let connections = [];
let segmentation = null;

/* ---------- Visuals ---------- */
const BAND_COUNT = 360;       // background bands
const SHOW_MASKED_VIDEO = true;

/* ---------- Color palette (Yellow → Red) ---------- */
const RED_HUE   = 5;          // fast end (deeper red)
const YEL_HUE   = 57;         // slow end (bright yellow)
const SAT_MIN   = 85, SAT_MAX = 98;
const BRI_MIN   = 90, BRI_MAX = 100;

/* ---------- Motion tracking ---------- */
const SMOOTH_SPEED_1  = 0.48;
const SMOOTH_SPEED_2  = 0.28;
const MOTION_DEADZONE = 0.080;
const SPEED_GAIN      = 3.0;

/* ---------- Color transitions ---------- */
const ACTIVE_TAU_SEC  = 0.80; // approach when moving
const IDLE_TAU_SEC    = 0.35; // return when idle
const SATBRI_TAU_SEC  = 0.40; // sat/bright glide
const IDLE_ENTER      = 0.010; // below => idle
const IDLE_EXIT       = 0.020; // above => active

/* ---------- State ---------- */
let spdRaw = 0, spdLP1 = 0, spdLP2 = 0;
let isIdle = true;
let showDebug = true;
let showSkeleton = true;
let showFluid = true;
let hueNow = YEL_HUE, satNow = SAT_MIN, briNow = BRI_MIN;
let ringPhase = 0; // For pulsing rings effect

let lastPts = null;
let lastTime = 0;
let frameCounter = 0;
let fps = 0, fpsUpdateTime = 0, fpsFrameCount = 0;

// Kalman filter for skeleton smoothing
const PROCESS_NOISE = 0.8;    // higher = less trust in predictions
const MEASUREMENT_NOISE = 1.5; // lower = more trust in ML5 measurements (more responsive)
let kalmanFilters = [];

// SES for segmentation mask smoothing
const MASK_SES_ALPHA = 0.3; // 0.3-0.5 recommended, higher = more responsive
let smoothedMask = null;

/* ---------- WebGL Fluid Simulation ---------- */
let fluidCanvas, gl;
let fluidSim = null;

// Track previous keypoint positions for velocity calculation
let prevKeypoints = {};

// Fluid simulation configuration
const FLUID_CONFIG = {
  SIM_RESOLUTION: 128,
  DYE_RESOLUTION: 512,
  DENSITY_DISSIPATION: 0.97,
  VELOCITY_DISSIPATION: 0.98,
  PRESSURE_ITERATIONS: 20,
  CURL: 30,
  SPLAT_RADIUS: 0.25,
  SPLAT_FORCE: 6000,
  COLOR_UPDATE_SPEED: 10
};

function preload() {
  bodyPose = ml5.bodyPose('BlazePose');
  bodySegmentation = ml5.bodySegmentation('SelfieSegmentation', { 
    maskType: 'background',
    smoothSegmentation: true
  });
}

function setup() {
  createCanvas(640, 480);
  colorMode(HSB, 360, 100, 100, 100);

  video = createCapture(VIDEO);
  video.size(320, 240);
  video.hide();

  bodyPose.detectStart(video, r => poses = r);
  bodySegmentation.detectStart(video, r => segmentation = r);

  if (bodyPose.getSkeleton) connections = bodyPose.getSkeleton() || [];
  lastTime = millis();

  // Initialize WebGL fluid simulation
  initFluidSimulation();
}

function keyPressed() {
  if (key === 'd' || key === 'D') showDebug = !showDebug;
  if (key === 's' || key === 'S') showSkeleton = !showSkeleton;
  if (key === 'f' || key === 'F') showFluid = !showFluid;
}

function draw() {
  background(0);
  frameCounter++;

  // --- FPS calculation ---
  fpsFrameCount++;
  const now = millis();
  if (now - fpsUpdateTime >= 500) { // Update FPS every 500ms
    fps = (fpsFrameCount / ((now - fpsUpdateTime) / 1000)).toFixed(1);
    fpsFrameCount = 0;
    fpsUpdateTime = now;
  }

  // --- dt-aware body speed ---
  const dtSec = max(0.001, (now - lastTime) / 1000.0);
  lastTime    = now;

  const v = measureBodyVelocity(poses, dtSec) || 0;
  spdRaw = max(0, v - MOTION_DEADZONE);
  spdLP1 = lerp(spdLP1, spdRaw, SMOOTH_SPEED_1);
  spdLP2 = lerp(spdLP2, spdLP1, SMOOTH_SPEED_2);

  // --- idle hysteresis ---
  if (isIdle) { if (spdLP2 > IDLE_EXIT) isIdle = false; }
  else        { if (spdLP2 < IDLE_ENTER) isIdle = true; }

  // --- speed → color mapping (Turbo with quick snap-back) ---
  const EFFECTIVE_GAIN = SPEED_GAIN * 2.0; // extra multiplier

  let tLinear = constrain(spdLP2 * EFFECTIVE_GAIN, 0, 1);

  // Gamma + strong ease-out for active pop
  const GAMMA = 0.82;
  let tColor = easeOutQuint(pow(tLinear, GAMMA));

  // If idle, shrink tColor quickly toward 0 (snap back to yellow)
  if (isIdle) {
    const SNAP_TAU = 0.40; // ↑ this for more delay; ↓ for faster snap
    const snap = 1.0 - Math.exp(-dtSec / SNAP_TAU);
    tColor = lerp(tColor, 0, snap);
  }

  // REVERSED RANGE: yellow (idle) → red (fast)
  const hueTarget = lerpHue(YEL_HUE, RED_HUE, tColor);
  const satTarget = lerp(SAT_MIN,   SAT_MAX,   tColor);
  const briTarget = lerp(BRI_MIN,   BRI_MAX,   tColor);

  // --- time-constant smoothing (fast return when idle) ---
  // Only update background colors every other frame for smoothness
  if (frameCounter % 2 === 0) {
    const tauHue = isIdle ? IDLE_TAU_SEC : ACTIVE_TAU_SEC;
    const tauSB  = SATBRI_TAU_SEC;

    const aHue = 1.0 - Math.exp(-dtSec / max(1e-3, tauHue));
    const aSB  = 1.0 - Math.exp(-dtSec / max(1e-3, tauSB));

    hueNow = lerpHue(hueNow, hueTarget, aHue);
    satNow = lerp(satNow,   satTarget, aSB);
    briNow = lerp(briNow,   briTarget, aSB);
  }

  // --- Update and render fluid simulation ---
  if (showFluid && fluidSim) {
    // Inject splats at body keypoints
    injectBodySplats(poses, dtSec);

    // Update fluid simulation
    fluidSim.update();

    // Draw fluid to p5 canvas
    drawFluidToCanvas();
  } else {
    // Fallback: original background with vignette
    background(hueNow, satNow, briNow);
    noStroke();
    const maxR = max(width, height) * 1.05;
    for (let r = maxR; r > maxR * 0.85; r -= 8) {
      const t = 1 - (r / maxR);
      fill(0, 0, 0, t * 1.5);
      ellipse(width / 2, height / 2, r, r * 0.85);
    }

    // pulsing rings (speed reactive)
    ringPhase += spdLP2 * 8;
    noFill();
    strokeWeight(2);
    for (let i = 0; i < 5; i++) {
      const r = ((ringPhase + i * 100) % 600);
      const alpha = map(r, 0, 600, 40, 0);
      stroke(hueNow, satNow, briNow + 10, alpha);
      ellipse(width / 2, height / 2, r * 2, r * 2);
    }
  }

  // --- segmented person on top ---
  if (SHOW_MASKED_VIDEO && segmentation && segmentation.mask) {
    const processedMask = segmentation.mask.get();
    
    // SES temporal smoothing for mask stability
    if (!smoothedMask) {
      smoothedMask = processedMask.get();
    } else {
      smoothedMask.loadPixels();
      processedMask.loadPixels();
      for (let i = 0; i < smoothedMask.pixels.length; i++) {
        smoothedMask.pixels[i] = lerp(smoothedMask.pixels[i], processedMask.pixels[i], MASK_SES_ALPHA);
      }
      smoothedMask.updatePixels();
    }
    
    const masked = video.get();
    masked.mask(smoothedMask);
    image(masked, 0, 0, width, height);
  }

  // --- skeleton + chest direction ---
  if (showSkeleton && poses && poses.length) {
    const smoothed = smoothKeypoints(poses);
    drawSkeletonAndChest(smoothed);
  }

  // --- HUD ---
  if (showDebug) {
    noStroke();
    fill(0, 0, 0, 65);
    rect(10, 10, 520, 105, 8);
    fill(0, 0, 100);
    textSize(12);
    text(`FPS: ${fps}`, 20, 30);
    text(`speed raw:${spdRaw.toFixed(3)}  lp:${spdLP2.toFixed(3)}  t:${tLinear.toFixed(2)}`, 20, 46);
    text(`hue:${hueNow.toFixed(1)}  sat:${satNow.toFixed(0)}  bri:${briNow.toFixed(0)}  idle:${isIdle}`, 20, 62);
    text(`[D] HUD  [S] skeleton  [F] fluid:${showFluid}  gain:${SPEED_GAIN}  deadzone:${MOTION_DEADZONE}`, 20, 78);
  }
}

/* ---------------- Kalman Filter 2D (state: [x, y, vx, vy]) ---------------- */
class KalmanFilter2D {
  constructor(processNoise, measurementNoise) {
    // State: [x, y, vx, vy]
    this.state = [0, 0, 0, 0];
    
    // Error covariance matrix (4x4, simplified as diagonal)
    this.P = [1000, 1000, 1000, 1000];
    
    // Process noise
    this.Q = processNoise;
    
    // Measurement noise
    this.R = measurementNoise;
    
    this.initialized = false;
  }
  
  predict(dt = 1/60) {
    // Predict next state: x = x + vx*dt, y = y + vy*dt
    this.state[0] += this.state[2] * dt;
    this.state[1] += this.state[3] * dt;
    
    // Update error covariance
    this.P[0] += this.Q;
    this.P[1] += this.Q;
    this.P[2] += this.Q;
    this.P[3] += this.Q;
  }
  
  update(measuredX, measuredY) {
    if (!this.initialized) {
      this.state = [measuredX, measuredY, 0, 0];
      this.initialized = true;
      return;
    }
    
    // Kalman gain for position
    const Kx = this.P[0] / (this.P[0] + this.R);
    const Ky = this.P[1] / (this.P[1] + this.R);
    
    // Update position state with measurement
    const innovationX = measuredX - this.state[0];
    const innovationY = measuredY - this.state[1];
    
    this.state[0] += Kx * innovationX;
    this.state[1] += Ky * innovationY;
    
    // Update velocity based on innovation
    const Kv = 0.5; // Velocity learning rate (higher = faster catch-up)
    this.state[2] += Kv * innovationX;
    this.state[3] += Kv * innovationY;
    
    // Update error covariance
    this.P[0] *= (1 - Kx);
    this.P[1] *= (1 - Ky);
  }
  
  getPosition() {
    return { x: this.state[0], y: this.state[1] };
  }
}

/* ---------------- Apply Kalman Filter to Skeleton ---------------- */
function smoothKeypoints(poses) {
  if (!poses || !poses.length || !poses[0].keypoints) {
    kalmanFilters = [];
    return poses;
  }
  
  const currentKeypoints = poses[0].keypoints;
  
  // Initialize Kalman filters on first frame
  if (kalmanFilters.length !== currentKeypoints.length) {
    kalmanFilters = currentKeypoints.map(() => 
      new KalmanFilter2D(PROCESS_NOISE, MEASUREMENT_NOISE)
    );
  }
  
  // Apply Kalman filter to each keypoint
  const dt = 1/60; // Assume 60 FPS
  const smoothedKps = currentKeypoints.map((kp, i) => {
    const filter = kalmanFilters[i];
    
    // Predict then update with measurement
    filter.predict(dt);
    filter.update(kp.x, kp.y);
    
    // Get filtered position
    const filtered = filter.getPosition();
    
    return {
      x: filtered.x,
      y: filtered.y,
      confidence: kp.confidence,
      name: kp.name
    };
  });
  
  return [{...poses[0], keypoints: smoothedKps}];
}

/* ---------------- Skeleton + Chest Direction ---------------- */
function drawSkeletonAndChest(poses) {
  const sX = width / video.width;
  const sY = height / video.height;

  stroke(255, 0, 0);
  strokeWeight(2);

  for (const pose of poses) {
    // skeleton lines
    for (const [aIndex, bIndex] of connections) {
      const a = pose.keypoints[aIndex];
      const b = pose.keypoints[bIndex];
      if (confOK(a) && confOK(b)) {
        line(a.x * sX, a.y * sY, b.x * sX, b.y * sY);
      }
    }

    // keypoints
    noStroke();
    fill(0, 255, 0);
    for (const kp of pose.keypoints) {
      if (confOK(kp)) circle(kp.x * sX, kp.y * sY, 6);
    }

    // chest point + connectors + facing arrow
    const LS = getKP(pose, 'left_shoulder');
    const RS = getKP(pose, 'right_shoulder');
    const LH = getKP(pose, 'left_hip');
    const RH = getKP(pose, 'right_hip');

    if (LS && RS) {
      const shoulderMid = { x: (LS.x + RS.x) / 2, y: (LS.y + RS.y) / 2 };
      let chestX = shoulderMid.x, chestY = shoulderMid.y;
      if (LH && RH) {
        const hipMid = { x: (LH.x + RH.x) / 2, y: (LH.y + RH.y) / 2 };
        chestX = 0.7 * shoulderMid.x + 0.3 * hipMid.x;
        chestY = 0.7 * shoulderMid.y + 0.3 * hipMid.y;
      }
      chestX *= sX; chestY *= sY;

      // chest dot
      fill(0, 255, 255);
      noStroke();
      circle(chestX, chestY, 10);

      // connectors
      stroke(255);
      strokeWeight(2);
      line(chestX, chestY, LS.x * sX, LS.y * sY);
      line(chestX, chestY, RS.x * sX, RS.y * sY);
      if (LH) line(chestX, chestY, LH.x * sX, LH.y * sY);
      if (RH) line(chestX, chestY, RH.x * sX, RH.y * sY);

      // facing arrow (perpendicular to shoulders)
      const vS = createVector((RS.x - LS.x) * sX, (RS.y - LS.y) * sY);
      if (vS.mag() > 1e-3) {
        const n = createVector(-vS.y, vS.x).normalize();
        const L = constrain(vS.mag() * 0.4, 30, 120);
        stroke(255);
        strokeWeight(3);
        drawArrow(createVector(chestX, chestY),
                  p5.Vector.add(createVector(chestX, chestY), n.mult(L)));
      }
    }
  }
}

/* ---------------- Motion (body velocity) ----------------
   Confidence-weighted avg displacement per second, normalized by canvas diagonal
--------------------------------------------------------- */
function measureBodyVelocity(posesArr, dtSec) {
  if (!posesArr || !posesArr.length) { lastPts = null; return 0; }
  const pose = posesArr[0];
  if (!pose.keypoints || !pose.keypoints.length) { lastPts = null; return 0; }

  const names = [
    'nose',
    'left_shoulder','right_shoulder',
    'left_elbow','right_elbow',
    'left_wrist','right_wrist',
    'left_hip','right_hip',
    'left_knee','right_knee'
  ];

  const curr = [], conf = [];
  for (const nm of names) {
    const kp = getKP(pose, nm);
    if (kp) { curr.push({ x: kp.x, y: kp.y }); conf.push(kp.confidence); }
  }
  if (curr.length < 4) { lastPts = null; return 0; }

  let disp = 0, wsum = 0;
  if (lastPts && lastPts.length === curr.length) {
    for (let i = 0; i < curr.length; i++) {
      const d = Math.hypot(curr[i].x - lastPts[i].x, curr[i].y - lastPts[i].y);
      const w = conf[i];
      disp += d * w; wsum += w;
    }
    if (wsum > 0) disp /= wsum;
  }
  lastPts = curr;

  const pixPerSec = disp / max(0.001, dtSec);
  const diag = Math.hypot(width, height);
  return pixPerSec / (diag * 2.0);
}

/* ---------------- Helpers ---------------- */
function confOK(kp) { return kp && kp.confidence > 0.1; }

// Find a keypoint by name across ml5 variants
function getKP(pose, name) {
  if (!pose || !pose.keypoints) return null;
  return pose.keypoints.find(k =>
    (k.name === name || k.part === name) && k.confidence > 0.1
  ) || null;
}

function drawArrow(from, to) {
  line(from.x, from.y, to.x, to.y);
  const v = p5.Vector.sub(to, from).normalize();
  const head = 10;
  const L = p5.Vector.add(to, p5.Vector.mult(rotate2D(v, radians(150)), head));
  const R = p5.Vector.add(to, p5.Vector.mult(rotate2D(v, radians(-150)), head));
  triangle(to.x, to.y, L.x, L.y, R.x, R.y);
}

function rotate2D(v, a) {
  const c = cos(a), s = sin(a);
  return createVector(v.x * c - v.y * s, v.x * s + v.y * c);
}

// Shortest-path hue interpolation
function lerpHue(h1, h2, a) {
  let dh = ((h2 - h1 + 540) % 360) - 180;
  return (h1 + dh * constrain(a, 0, 1) + 360) % 360;
}

// Strong ease-out for fast snap to target
function easeOutQuint(x){
  x = constrain(x, 0, 1);
  return 1 - pow(1 - x, 5);
}

/* ================================================================================
   WebGL FLUID SIMULATION
   Based on Navier-Stokes equations, GPU-accelerated
   Adapted from PavelDoGreat/WebGL-Fluid-Simulation (MIT License)
   ================================================================================ */

function initFluidSimulation() {
  // Create a separate canvas for WebGL fluid
  fluidCanvas = document.createElement('canvas');
  fluidCanvas.width = width;
  fluidCanvas.height = height;
  fluidCanvas.style.position = 'absolute';
  fluidCanvas.style.top = '0';
  fluidCanvas.style.left = '0';
  fluidCanvas.style.pointerEvents = 'none';
  fluidCanvas.style.display = 'none'; // Hidden, we'll copy to p5

  document.body.appendChild(fluidCanvas);

  gl = fluidCanvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false });
  if (!gl) {
    gl = fluidCanvas.getContext('webgl', { alpha: true });
  }

  if (!gl) {
    console.warn('WebGL not supported, fluid simulation disabled');
    return;
  }

  // Enable extensions
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');

  fluidSim = new FluidSimulation(gl, fluidCanvas.width, fluidCanvas.height);
}

// Convert HSB to RGB (for WebGL which uses RGB)
function hsbToRgb(h, s, b) {
  h = h / 360;
  s = s / 100;
  b = b / 100;

  let r, g, bl;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = b * (1 - s);
  const q = b * (1 - f * s);
  const t = b * (1 - (1 - f) * s);

  switch (i % 6) {
    case 0: r = b; g = t; bl = p; break;
    case 1: r = q; g = b; bl = p; break;
    case 2: r = p; g = b; bl = t; break;
    case 3: r = p; g = q; bl = b; break;
    case 4: r = t; g = p; bl = b; break;
    case 5: r = b; g = p; bl = q; break;
  }
  return { r, g, b: bl };
}

// Inject fluid splats at body keypoints
function injectBodySplats(posesArr, dtSec) {
  if (!posesArr || !posesArr.length || !fluidSim) return;

  const pose = posesArr[0];
  if (!pose.keypoints) return;

  const sX = width / video.width;
  const sY = height / video.height;

  // Key points to track for splats (hands, elbows create more fluid)
  const splatPoints = [
    { name: 'left_wrist', radius: 1.0, force: 1.0 },
    { name: 'right_wrist', radius: 1.0, force: 1.0 },
    { name: 'left_elbow', radius: 0.7, force: 0.6 },
    { name: 'right_elbow', radius: 0.7, force: 0.6 },
    { name: 'nose', radius: 0.5, force: 0.4 },
    { name: 'left_shoulder', radius: 0.5, force: 0.3 },
    { name: 'right_shoulder', radius: 0.5, force: 0.3 }
  ];

  // Get current color based on speed
  const rgb = hsbToRgb(hueNow, satNow, briNow);

  for (const pt of splatPoints) {
    const kp = getKP(pose, pt.name);
    if (!kp) continue;

    const x = kp.x * sX;
    const y = kp.y * sY;

    // Calculate velocity from previous position
    let dx = 0, dy = 0;
    if (prevKeypoints[pt.name]) {
      dx = (x - prevKeypoints[pt.name].x) / Math.max(0.016, dtSec);
      dy = (y - prevKeypoints[pt.name].y) / Math.max(0.016, dtSec);
    }
    prevKeypoints[pt.name] = { x, y };

    // Only create splat if there's movement
    const speed = Math.sqrt(dx * dx + dy * dy);
    if (speed > 5) {
      // Normalize coordinates to 0-1 range for WebGL
      const normX = x / width;
      const normY = y / height;

      // Scale force by speed and point importance
      const forceMult = Math.min(speed / 100, 3) * pt.force * (1 + spdLP2 * 2);

      fluidSim.splat(
        normX,
        normY,
        dx * forceMult * 0.5,
        dy * forceMult * 0.5,
        rgb.r * 0.8,
        rgb.g * 0.8,
        rgb.b * 0.8,
        FLUID_CONFIG.SPLAT_RADIUS * pt.radius
      );
    }
  }
}

// Copy fluid canvas to p5.js canvas
function drawFluidToCanvas() {
  if (!fluidSim || !fluidCanvas) return;

  // Draw a dark background first
  background(0);

  // Use p5's drawingContext to draw the WebGL canvas
  drawingContext.drawImage(fluidCanvas, 0, 0, width, height);
}

/* ---------------- WebGL Fluid Simulation Class ---------------- */
class FluidSimulation {
  constructor(gl, width, height) {
    this.gl = gl;
    this.width = width;
    this.height = height;

    // Calculate simulation resolution
    const simRes = this.getResolution(FLUID_CONFIG.SIM_RESOLUTION);
    const dyeRes = this.getResolution(FLUID_CONFIG.DYE_RESOLUTION);

    this.simWidth = simRes.width;
    this.simHeight = simRes.height;
    this.dyeWidth = dyeRes.width;
    this.dyeHeight = dyeRes.height;

    // Compile shaders
    this.programs = this.createPrograms();

    // Create framebuffers
    this.density = this.createDoubleFBO(this.dyeWidth, this.dyeHeight, gl.RGBA, gl.FLOAT);
    this.velocity = this.createDoubleFBO(this.simWidth, this.simHeight, gl.RG, gl.FLOAT);
    this.pressure = this.createDoubleFBO(this.simWidth, this.simHeight, gl.R, gl.FLOAT);
    this.divergence = this.createFBO(this.simWidth, this.simHeight, gl.R, gl.FLOAT);
    this.curl = this.createFBO(this.simWidth, this.simHeight, gl.R, gl.FLOAT);

    // Create fullscreen quad
    this.quadBuffer = this.createQuadBuffer();

    this.lastTime = performance.now();
  }

  getResolution(resolution) {
    let aspectRatio = this.width / this.height;
    if (aspectRatio < 1) aspectRatio = 1 / aspectRatio;

    const min = Math.round(resolution);
    const max = Math.round(resolution * aspectRatio);

    if (this.width > this.height) {
      return { width: max, height: min };
    }
    return { width: min, height: max };
  }

  createPrograms() {
    const gl = this.gl;

    // Vertex shader (shared)
    const vertexShader = `
      attribute vec2 aPosition;
      varying vec2 vUv;
      varying vec2 vL;
      varying vec2 vR;
      varying vec2 vT;
      varying vec2 vB;
      uniform vec2 texelSize;

      void main() {
        vUv = aPosition * 0.5 + 0.5;
        vL = vUv - vec2(texelSize.x, 0.0);
        vR = vUv + vec2(texelSize.x, 0.0);
        vT = vUv + vec2(0.0, texelSize.y);
        vB = vUv - vec2(0.0, texelSize.y);
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `;

    // Fragment shaders
    const splatShader = `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTarget;
      uniform float aspectRatio;
      uniform vec3 color;
      uniform vec2 point;
      uniform float radius;

      void main() {
        vec2 p = vUv - point;
        p.x *= aspectRatio;
        vec3 splat = exp(-dot(p, p) / radius) * color;
        vec3 base = texture2D(uTarget, vUv).xyz;
        gl_FragColor = vec4(base + splat, 1.0);
      }
    `;

    const advectionShader = `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uVelocity;
      uniform sampler2D uSource;
      uniform vec2 texelSize;
      uniform float dt;
      uniform float dissipation;

      void main() {
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        gl_FragColor = dissipation * texture2D(uSource, coord);
      }
    `;

    const divergenceShader = `
      precision highp float;
      varying vec2 vUv;
      varying vec2 vL;
      varying vec2 vR;
      varying vec2 vT;
      varying vec2 vB;
      uniform sampler2D uVelocity;

      void main() {
        float L = texture2D(uVelocity, vL).x;
        float R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y;
        float B = texture2D(uVelocity, vB).y;
        float div = 0.5 * (R - L + T - B);
        gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
      }
    `;

    const curlShader = `
      precision highp float;
      varying vec2 vUv;
      varying vec2 vL;
      varying vec2 vR;
      varying vec2 vT;
      varying vec2 vB;
      uniform sampler2D uVelocity;

      void main() {
        float L = texture2D(uVelocity, vL).y;
        float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x;
        float B = texture2D(uVelocity, vB).x;
        float vorticity = R - L - T + B;
        gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
      }
    `;

    const vorticityShader = `
      precision highp float;
      varying vec2 vUv;
      varying vec2 vL;
      varying vec2 vR;
      varying vec2 vT;
      varying vec2 vB;
      uniform sampler2D uVelocity;
      uniform sampler2D uCurl;
      uniform float curl;
      uniform float dt;

      void main() {
        float L = texture2D(uCurl, vL).x;
        float R = texture2D(uCurl, vR).x;
        float T = texture2D(uCurl, vT).x;
        float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;

        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl * C;
        force.y *= -1.0;

        vec2 vel = texture2D(uVelocity, vUv).xy;
        gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);
      }
    `;

    const pressureShader = `
      precision highp float;
      varying vec2 vUv;
      varying vec2 vL;
      varying vec2 vR;
      varying vec2 vT;
      varying vec2 vB;
      uniform sampler2D uPressure;
      uniform sampler2D uDivergence;

      void main() {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        float C = texture2D(uPressure, vUv).x;
        float divergence = texture2D(uDivergence, vUv).x;
        float pressure = (L + R + B + T - divergence) * 0.25;
        gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
      }
    `;

    const gradientSubtractShader = `
      precision highp float;
      varying vec2 vUv;
      varying vec2 vL;
      varying vec2 vR;
      varying vec2 vT;
      varying vec2 vB;
      uniform sampler2D uPressure;
      uniform sampler2D uVelocity;

      void main() {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity.xy -= vec2(R - L, T - B);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
      }
    `;

    const displayShader = `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTexture;

      void main() {
        vec3 c = texture2D(uTexture, vUv).rgb;
        float a = max(c.r, max(c.g, c.b));
        gl_FragColor = vec4(c, a);
      }
    `;

    const clearShader = `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTexture;
      uniform float value;

      void main() {
        gl_FragColor = value * texture2D(uTexture, vUv);
      }
    `;

    return {
      splat: this.createProgram(vertexShader, splatShader),
      advection: this.createProgram(vertexShader, advectionShader),
      divergence: this.createProgram(vertexShader, divergenceShader),
      curl: this.createProgram(vertexShader, curlShader),
      vorticity: this.createProgram(vertexShader, vorticityShader),
      pressure: this.createProgram(vertexShader, pressureShader),
      gradientSubtract: this.createProgram(vertexShader, gradientSubtractShader),
      display: this.createProgram(vertexShader, displayShader),
      clear: this.createProgram(vertexShader, clearShader)
    };
  }

  createProgram(vertexSource, fragmentSource) {
    const gl = this.gl;

    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertexShader, vertexSource);
    gl.compileShader(vertexShader);

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragmentShader, fragmentSource);
    gl.compileShader(fragmentShader);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    return {
      program,
      uniforms: this.getUniforms(program)
    };
  }

  getUniforms(program) {
    const gl = this.gl;
    const uniforms = {};
    const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < uniformCount; i++) {
      const uniformName = gl.getActiveUniform(program, i).name;
      uniforms[uniformName] = gl.getUniformLocation(program, uniformName);
    }
    return uniforms;
  }

  createFBO(w, h, internalFormat, format) {
    const gl = this.gl;

    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Use appropriate format based on WebGL version
    let intFormat = gl.RGBA;
    let texFormat = gl.RGBA;
    let texType = gl.UNSIGNED_BYTE;

    if (gl instanceof WebGL2RenderingContext) {
      if (internalFormat === gl.R) {
        intFormat = gl.R16F;
        texFormat = gl.RED;
        texType = gl.HALF_FLOAT;
      } else if (internalFormat === gl.RG) {
        intFormat = gl.RG16F;
        texFormat = gl.RG;
        texType = gl.HALF_FLOAT;
      } else {
        intFormat = gl.RGBA16F;
        texFormat = gl.RGBA;
        texType = gl.HALF_FLOAT;
      }
    }

    gl.texImage2D(gl.TEXTURE_2D, 0, intFormat, w, h, 0, texFormat, texType, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      texture,
      fbo,
      width: w,
      height: h,
      attach: (id) => {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      }
    };
  }

  createDoubleFBO(w, h, internalFormat, format) {
    let fbo1 = this.createFBO(w, h, internalFormat, format);
    let fbo2 = this.createFBO(w, h, internalFormat, format);

    return {
      width: w,
      height: h,
      texelSizeX: 1.0 / w,
      texelSizeY: 1.0 / h,
      get read() { return fbo1; },
      set read(value) { fbo1 = value; },
      get write() { return fbo2; },
      set write(value) { fbo2 = value; },
      swap: () => {
        const temp = fbo1;
        fbo1 = fbo2;
        fbo2 = temp;
      }
    };
  }

  createQuadBuffer() {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    return buffer;
  }

  blit(destination) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    if (destination == null) {
      gl.viewport(0, 0, this.width, this.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, destination.width, destination.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, destination.fbo);
    }

    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  splat(x, y, dx, dy, r, g, b, radius) {
    const gl = this.gl;

    // Add velocity
    gl.useProgram(this.programs.splat.program);
    gl.uniform1i(this.programs.splat.uniforms.uTarget, this.velocity.read.attach(0));
    gl.uniform1f(this.programs.splat.uniforms.aspectRatio, this.width / this.height);
    gl.uniform2f(this.programs.splat.uniforms.point, x, 1.0 - y);
    gl.uniform3f(this.programs.splat.uniforms.color, dx, -dy, 0.0);
    gl.uniform1f(this.programs.splat.uniforms.radius, radius / 100.0);
    this.blit(this.velocity.write);
    this.velocity.swap();

    // Add dye
    gl.uniform1i(this.programs.splat.uniforms.uTarget, this.density.read.attach(0));
    gl.uniform3f(this.programs.splat.uniforms.color, r, g, b);
    this.blit(this.density.write);
    this.density.swap();
  }

  update() {
    const gl = this.gl;
    const now = performance.now();
    let dt = (now - this.lastTime) / 1000;
    dt = Math.min(dt, 0.016666);
    this.lastTime = now;

    // Curl
    gl.useProgram(this.programs.curl.program);
    gl.uniform2f(this.programs.curl.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.programs.curl.uniforms.uVelocity, this.velocity.read.attach(0));
    this.blit(this.curl);

    // Vorticity
    gl.useProgram(this.programs.vorticity.program);
    gl.uniform2f(this.programs.vorticity.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.programs.vorticity.uniforms.uVelocity, this.velocity.read.attach(0));
    gl.uniform1i(this.programs.vorticity.uniforms.uCurl, this.curl.attach(1));
    gl.uniform1f(this.programs.vorticity.uniforms.curl, FLUID_CONFIG.CURL);
    gl.uniform1f(this.programs.vorticity.uniforms.dt, dt);
    this.blit(this.velocity.write);
    this.velocity.swap();

    // Divergence
    gl.useProgram(this.programs.divergence.program);
    gl.uniform2f(this.programs.divergence.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.programs.divergence.uniforms.uVelocity, this.velocity.read.attach(0));
    this.blit(this.divergence);

    // Clear pressure
    gl.useProgram(this.programs.clear.program);
    gl.uniform1i(this.programs.clear.uniforms.uTexture, this.pressure.read.attach(0));
    gl.uniform1f(this.programs.clear.uniforms.value, 0.8);
    this.blit(this.pressure.write);
    this.pressure.swap();

    // Pressure solve
    gl.useProgram(this.programs.pressure.program);
    gl.uniform2f(this.programs.pressure.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.programs.pressure.uniforms.uDivergence, this.divergence.attach(0));
    for (let i = 0; i < FLUID_CONFIG.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(this.programs.pressure.uniforms.uPressure, this.pressure.read.attach(1));
      this.blit(this.pressure.write);
      this.pressure.swap();
    }

    // Gradient subtract
    gl.useProgram(this.programs.gradientSubtract.program);
    gl.uniform2f(this.programs.gradientSubtract.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.programs.gradientSubtract.uniforms.uPressure, this.pressure.read.attach(0));
    gl.uniform1i(this.programs.gradientSubtract.uniforms.uVelocity, this.velocity.read.attach(1));
    this.blit(this.velocity.write);
    this.velocity.swap();

    // Advect velocity
    gl.useProgram(this.programs.advection.program);
    gl.uniform2f(this.programs.advection.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.programs.advection.uniforms.uVelocity, this.velocity.read.attach(0));
    gl.uniform1i(this.programs.advection.uniforms.uSource, this.velocity.read.attach(0));
    gl.uniform1f(this.programs.advection.uniforms.dt, dt);
    gl.uniform1f(this.programs.advection.uniforms.dissipation, FLUID_CONFIG.VELOCITY_DISSIPATION);
    this.blit(this.velocity.write);
    this.velocity.swap();

    // Advect dye
    gl.uniform2f(this.programs.advection.uniforms.texelSize, this.density.texelSizeX, this.density.texelSizeY);
    gl.uniform1i(this.programs.advection.uniforms.uVelocity, this.velocity.read.attach(0));
    gl.uniform1i(this.programs.advection.uniforms.uSource, this.density.read.attach(1));
    gl.uniform1f(this.programs.advection.uniforms.dissipation, FLUID_CONFIG.DENSITY_DISSIPATION);
    this.blit(this.density.write);
    this.density.swap();

    // Display
    gl.useProgram(this.programs.display.program);
    gl.uniform1i(this.programs.display.uniforms.uTexture, this.density.read.attach(0));
    this.blit(null);
  }
}

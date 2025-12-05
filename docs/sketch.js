/*
 * BODY-DRIVEN Speed Map (Yellow → Red)
 * Idle = bright yellow, Fast = deep red
 * Turbo responsive + optional quick snap-back
 * + Skeleton, Virtual Chest, Facing Arrow
 * - [D] toggle HUD, [S] toggle skeleton
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

/* ---------- Color palette (reversed: Yellow → Red) ---------- */
// Yellow is the slow/idle end; Red is the fast end
const RED_HUE   = 5;          // fast end (deeper red)
const YEL_HUE   = 57;         // slow end (bright yellow)

// Slightly narrower saturation + brighter idle so yellow is vivid
const SAT_MIN   = 85, SAT_MAX = 98;
const BRI_MIN   = 90, BRI_MAX = 100;

/* ---------- Turbo responsiveness ---------- */
let hueNow = YEL_HUE;         // start at yellow
let satNow = SAT_MIN;
let briNow = BRI_MIN;

// Faster tracking of motion
const SMOOTH_SPEED_1  = 0.38;
const SMOOTH_SPEED_2  = 0.28;
const MOTION_DEADZONE = 0.080;
const SPEED_GAIN      = 2.0;  // motion sensitivity

// Faster easing to target colors
const ACTIVE_TAU_SEC  = 0.80; // approach when moving (fast)
const IDLE_TAU_SEC    = 0.35; // return when idle (quick snap-back)
const SATBRI_TAU_SEC  = 0.40; // sat/bright glide

// Idle hysteresis
const IDLE_ENTER      = 0.010; // below => idle
const IDLE_EXIT       = 0.020; // above => active

/* ---------- State ---------- */
let spdRaw = 0, spdLP1 = 0, spdLP2 = 0;
let isIdle = true;
let showDebug = true;
let showSkeleton = true;

let lastPts = null;  // for velocity
let lastTime = 0;
let frameCounter = 0; // for updating background every other frame
let fps = 0;
let fpsUpdateTime = 0;
let fpsFrameCount = 0;

// Adaptive SES smoothing for skeleton
const SES_ALPHA_FAST = 0.90; // when moving (responsive)
const SES_ALPHA_SLOW = 0.70; // when idle (smooth out jitter)
let smoothedKeypoints = null;

function preload() {
  // Pose model (BlazePose recommended)
  bodyPose = ml5.bodyPose('BlazePose');  // or ml5.bodyPose() for MoveNet
  // Segmentation (keeps foreground person)
  bodySegmentation = ml5.bodySegmentation('SelfieSegmentation', { maskType: 'background' });
}

function setup() {
  createCanvas(640, 480);
  colorMode(HSB, 360, 100, 100, 100);
  pixelDensity(1);

  video = createCapture(VIDEO);
  video.size(640, 480);
  video.hide();

  bodyPose.detectStart(video, r => poses = r);
  bodySegmentation.detectStart(video, r => segmentation = r);

  if (bodyPose.getSkeleton) connections = bodyPose.getSkeleton() || [];
  lastTime = millis();
}

function keyPressed() {
  if (key === 'd' || key === 'D') showDebug = !showDebug;
  if (key === 's' || key === 'S') showSkeleton = !showSkeleton;
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

  // --- background gradient (bright & fast-reacting) ---
  noStroke();
  const bandH = height / BAND_COUNT;
  for (let i = 0; i < BAND_COUNT; i++) {
    fill(hueNow, satNow, briNow);
    rect(0, i * bandH, width, bandH + 1);
  }

  // --- segmented person on top ---
  if (SHOW_MASKED_VIDEO && segmentation && segmentation.mask) {
    const masked = video.get();
    masked.mask(segmentation.mask);
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
    text(`[D] HUD  [S] skeleton  gain:${SPEED_GAIN} (x2 local)  deadzone:${MOTION_DEADZONE}`, 20, 78);
  }
}

/* ---------------- Adaptive Simple Exponential Smoothing ---------------- */
function smoothKeypoints(poses) {
  if (!poses || !poses.length || !poses[0].keypoints) {
    smoothedKeypoints = null;
    return poses;
  }
  
  const currentKeypoints = poses[0].keypoints;
  
  // Initialize on first frame
  if (!smoothedKeypoints || smoothedKeypoints.length !== currentKeypoints.length) {
    smoothedKeypoints = currentKeypoints.map(kp => ({...kp, x: kp.x, y: kp.y}));
    return poses;
  }
  
  // Apply SES with adaptive alpha: S_t = α * Y_t + (1 - α) * S_(t-1)
  // Alpha varies based on speed: fast movement = high alpha (responsive), slow/idle = low alpha (smooth)
  const adaptiveAlpha = map(spdLP2, 0, 0.5, SES_ALPHA_SLOW, SES_ALPHA_FAST, true);
  
  for (let i = 0; i < currentKeypoints.length; i++) {
    smoothedKeypoints[i].x = adaptiveAlpha * currentKeypoints[i].x + (1 - adaptiveAlpha) * smoothedKeypoints[i].x;
    smoothedKeypoints[i].y = adaptiveAlpha * currentKeypoints[i].y + (1 - adaptiveAlpha) * smoothedKeypoints[i].y;
    smoothedKeypoints[i].confidence = currentKeypoints[i].confidence;
    smoothedKeypoints[i].name = currentKeypoints[i].name;
  }
  
  return [{...poses[0], keypoints: smoothedKeypoints}];
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

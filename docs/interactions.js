/*
 * ===============================================================================
 * BODY-DRIVEN INTERACTIVE VISUAL EXPERIENCE
 * ===============================================================================
 *
 * Features:
 * - Speed-reactive color system (Yellow → Red based on movement)
 * - WebGL fluid dynamics driven by body keypoints
 * - Real-time skeleton tracking with Kalman filtering
 * - Body segmentation for foreground isolation
 * - Virtual chest point and facing direction indicator
 *
 * Controls:
 * - [D] Toggle debug HUD
 * - [S] Toggle skeleton visualization
 * - [F] Toggle fluid simulation
 *
 * Dependencies:
 * - p5.js (canvas rendering)
 * - ml5.js bodyPose (BlazePose model)
 * - ml5.js bodySegmentation (SelfieSegmentation)
 * - fluid-simulation.js (WebGL fluid dynamics module - must be loaded first)
 *
 * Enhancement suggestions:
 * - Add gesture recognition for interactive controls
 * - Support multiple people tracking
 * - Add audio reactivity
 * - Implement recording/playback functionality
 * - Add particle systems driven by body movement
 * - Support VR/AR output
 * ===============================================================================
 */

/* ===============================================================================
   GLOBAL VARIABLES
   =============================================================================== */

// Video and ML5 models
let video;
let bodyPose, bodySegmentation;
let poses = [];
let connections = [];
let segmentation = null;

/* ---------- Visual Configuration ---------- */
const BAND_COUNT = 360;       // Number of background bands (currently unused)
const SHOW_MASKED_VIDEO = true; // Whether to show segmented video

/* ---------- Color Palette (Yellow → Red) ----------
   Enhancement suggestions:
   - Add more color schemes (cool colors, rainbow, etc.)
   - Support custom color palettes from user input
   - Add color transitions based on different emotions/gestures
*/
const RED_HUE   = 5;    // Fast movement hue (deep red)
const YEL_HUE   = 57;   // Idle/slow movement hue (bright yellow)
const SAT_MIN   = 85, SAT_MAX = 98; // Saturation range
const BRI_MIN   = 90, BRI_MAX = 100; // Brightness range

/* ---------- Motion Tracking Parameters ----------
   Enhancement suggestions:
   - Make these adjustable via UI sliders
   - Add presets for different sensitivity levels
   - Implement auto-calibration based on user movement patterns
*/
const SMOOTH_SPEED_1  = 0.48;  // First-level speed smoothing (higher = less smooth)
const SMOOTH_SPEED_2  = 0.28;  // Second-level speed smoothing
const MOTION_DEADZONE = 0.080; // Minimum motion threshold
const SPEED_GAIN      = 3.0;   // Speed amplification factor

/* ---------- Color Transition Parameters ---------- */
const ACTIVE_TAU_SEC  = 0.80; // Time constant when moving (slower transition)
const IDLE_TAU_SEC    = 0.35; // Time constant when idle (faster snap back)
const SATBRI_TAU_SEC  = 0.40; // Time constant for saturation/brightness
const IDLE_ENTER      = 0.010; // Speed threshold to enter idle state
const IDLE_EXIT       = 0.020; // Speed threshold to exit idle state

/* ---------- Runtime State ---------- */
let spdRaw = 0, spdLP1 = 0, spdLP2 = 0; // Speed values (raw, smoothed 1, smoothed 2)
let isIdle = true; // Idle state flag
let showDebug = true; // Show debug HUD
let showSkeleton = true; // Show skeleton overlay
let showFluid = true; // Show fluid simulation
let hueNow = YEL_HUE, satNow = SAT_MIN, briNow = BRI_MIN; // Current HSB values
let ringPhase = 0; // Phase for pulsing rings effect (when fluid disabled)

let lastPts = null; // Previous keypoint positions for velocity calculation
let lastTime = 0; // Previous frame timestamp
let frameCounter = 0; // Total frames rendered
let fps = 0, fpsUpdateTime = 0, fpsFrameCount = 0; // FPS tracking

/* ---------- Kalman Filter Configuration ----------
   Kalman filtering provides smooth, predictive skeleton tracking
   Enhancement suggestions:
   - Add adaptive noise parameters based on confidence scores
   - Implement multi-hypothesis tracking for occlusions
*/
const PROCESS_NOISE = 0.8;    // Higher = less trust in predictions
const MEASUREMENT_NOISE = 1.5; // Lower = more trust in ML5 measurements
let kalmanFilters = [];

/* ---------- Segmentation Mask Smoothing ----------
   Simple Exponential Smoothing (SES) for stable mask edges
   Enhancement suggestions:
   - Add morphological operations (erosion/dilation) for cleaner edges
   - Implement temporal consistency checks
*/
const MASK_SES_ALPHA = 0.3; // 0.3-0.5 recommended, higher = more responsive
let smoothedMask = null;

/* ---------- WebGL Fluid Simulation ---------- */
let fluidCanvas, gl; // Fluid canvas and WebGL context
let fluidSim = null; // Fluid simulation instance

// Track previous keypoint positions for velocity calculation
let prevKeypoints = {};

/**
 * Fluid simulation configuration
 * Enhancement suggestions:
 * - Make these runtime-adjustable via dat.GUI or similar
 * - Add presets for different visual styles (smoky, electric, watery)
 * - Implement auto-tuning based on device performance
 */
const FLUID_CONFIG = {
  SIM_RESOLUTION: 128,          // Velocity field resolution (lower = faster, less detailed)
  DYE_RESOLUTION: 512,          // Color field resolution (higher = sharper colors)
  DENSITY_DISSIPATION: 0.97,   // How fast colors fade (0.9-0.99, higher = longer trails)
  VELOCITY_DISSIPATION: 0.98,  // How fast motion dies down (0.9-0.99)
  PRESSURE_ITERATIONS: 20,      // Accuracy of pressure solve (10-50)
  CURL: 30,                     // Vorticity confinement (swirl strength, 0-50)
  SPLAT_RADIUS: 0.25,          // Base size of fluid splats
  SPLAT_FORCE: 6000,           // Force multiplier for splats
  COLOR_UPDATE_SPEED: 10       // Unused - reserved for future color animation
};

/* ===============================================================================
   P5.JS LIFECYCLE FUNCTIONS
   =============================================================================== */

/**
 * p5.js preload function - loads ML5 models before setup
 * Enhancement suggestions:
 * - Add loading progress indicator
 * - Support model selection (different pose/segmentation models)
 * - Implement model caching for faster subsequent loads
 */
function preload() {
  bodyPose = ml5.bodyPose('BlazePose');
  bodySegmentation = ml5.bodySegmentation('SelfieSegmentation', {
    maskType: 'background',
    smoothSegmentation: true
  });
}

/**
 * p5.js setup function - initializes canvas, video, and models
 * Enhancement suggestions:
 * - Add responsive canvas sizing
 * - Support camera selection for multi-camera setups
 * - Add error handling for camera access denial
 */
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
  const fluidInit = initFluidSimulation(width, height, FLUID_CONFIG);
  if (fluidInit) {
    fluidCanvas = fluidInit.canvas;
    gl = fluidInit.gl;
    fluidSim = fluidInit.sim;
  }
}

/**
 * Handles keyboard input for toggling features
 * Enhancement suggestions:
 * - Add keyboard shortcuts for adjusting parameters (arrow keys, +/-)
 * - Implement preset switching (1-9 keys for different visual modes)
 * - Add screenshot/recording hotkeys
 */
function keyPressed() {
  if (key === 'd' || key === 'D') showDebug = !showDebug;
  if (key === 's' || key === 'S') showSkeleton = !showSkeleton;
  if (key === 'f' || key === 'F') showFluid = !showFluid;
}

/**
 * Main draw loop - renders every frame
 * Enhancement suggestions:
 * - Add performance monitoring and auto-quality adjustment
 * - Implement frame skipping for low-end devices
 * - Add transition effects when toggling features
 */
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

  // --- Delta time calculation for frame-rate independent motion ---
  const dtSec = max(0.001, (now - lastTime) / 1000.0);
  lastTime = now;

  // --- Measure and smooth body velocity ---
  const v = measureBodyVelocity(poses, dtSec) || 0;
  spdRaw = max(0, v - MOTION_DEADZONE);
  spdLP1 = lerp(spdLP1, spdRaw, SMOOTH_SPEED_1);
  spdLP2 = lerp(spdLP2, spdLP1, SMOOTH_SPEED_2);

  // --- Idle state detection with hysteresis ---
  if (isIdle) {
    if (spdLP2 > IDLE_EXIT) isIdle = false;
  } else {
    if (spdLP2 < IDLE_ENTER) isIdle = true;
  }

  // --- Speed to color mapping with perceptual ease-out curve ---
  const EFFECTIVE_GAIN = SPEED_GAIN * 2.0; // Extra multiplier for visibility
  let tLinear = constrain(spdLP2 * EFFECTIVE_GAIN, 0, 1);

  // Apply gamma and ease-out for better perceptual response
  const GAMMA = 0.82;
  let tColor = easeOutQuint(pow(tLinear, GAMMA));

  // Quick snap back to idle color when stopped
  if (isIdle) {
    const SNAP_TAU = 0.40;
    const snap = 1.0 - Math.exp(-dtSec / SNAP_TAU);
    tColor = lerp(tColor, 0, snap);
  }

  // Map to color range: yellow (idle) → red (fast)
  const hueTarget = lerpHue(YEL_HUE, RED_HUE, tColor);
  const satTarget = lerp(SAT_MIN, SAT_MAX, tColor);
  const briTarget = lerp(BRI_MIN, BRI_MAX, tColor);

  // --- Time-constant smoothing for natural color transitions ---
  // Only update every other frame to reduce flickering
  if (frameCounter % 2 === 0) {
    const tauHue = isIdle ? IDLE_TAU_SEC : ACTIVE_TAU_SEC;
    const tauSB = SATBRI_TAU_SEC;

    const aHue = 1.0 - Math.exp(-dtSec / max(1e-3, tauHue));
    const aSB = 1.0 - Math.exp(-dtSec / max(1e-3, tauSB));

    hueNow = lerpHue(hueNow, hueTarget, aHue);
    satNow = lerp(satNow, satTarget, aSB);
    briNow = lerp(briNow, briTarget, aSB);
  }

  // --- Render background (fluid or solid color with effects) ---
  if (showFluid && fluidSim) {
    // Inject fluid splats at body keypoints
    injectBodySplats(poses, dtSec);

    // Update fluid simulation physics
    fluidSim.update();

    // Draw fluid to p5 canvas
    background(0); // Dark background behind fluid
    drawFluidToCanvas(fluidCanvas, drawingContext, width, height);
  } else {
    // Fallback: solid color background with vignette and pulsing rings
    background(hueNow, satNow, briNow);

    // Subtle vignette effect
    noStroke();
    const maxR = max(width, height) * 1.05;
    for (let r = maxR; r > maxR * 0.85; r -= 8) {
      const t = 1 - (r / maxR);
      fill(0, 0, 0, t * 1.5);
      ellipse(width / 2, height / 2, r, r * 0.85);
    }

    // Speed-reactive pulsing rings
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

  // --- Render segmented person on top ---
  if (SHOW_MASKED_VIDEO && segmentation && segmentation.mask) {
    const processedMask = segmentation.mask.get();

    // Apply temporal smoothing to mask for stability
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

  // --- Render skeleton overlay ---
  if (showSkeleton && poses && poses.length) {
    const smoothed = smoothKeypoints(poses);
    drawSkeletonAndChest(smoothed);
  }

  // --- Debug HUD ---
  if (showDebug) {
    drawDebugHUD(tLinear);
  }
}

/* ===============================================================================
   KALMAN FILTER FOR SKELETON SMOOTHING
   =============================================================================== */

/**
 * 2D Kalman Filter for tracking a point with velocity
 * State vector: [x, y, vx, vy]
 *
 * Enhancement suggestions:
 * - Add acceleration to state for smoother predictions
 * - Implement adaptive noise based on tracking confidence
 * - Support occlusion handling (keep predicting when confidence drops)
 */
class KalmanFilter2D {
  constructor(processNoise, measurementNoise) {
    // State: [x, y, vx, vy]
    this.state = [0, 0, 0, 0];

    // Error covariance matrix (simplified as diagonal)
    this.P = [1000, 1000, 1000, 1000];

    // Process noise (uncertainty in motion model)
    this.Q = processNoise;

    // Measurement noise (uncertainty in sensor)
    this.R = measurementNoise;

    this.initialized = false;
  }

  /**
   * Prediction step: estimate next state using motion model
   * @param {number} dt - Time step in seconds
   */
  predict(dt = 1 / 60) {
    // Update position based on velocity: x = x + vx*dt
    this.state[0] += this.state[2] * dt;
    this.state[1] += this.state[3] * dt;

    // Increase uncertainty due to process noise
    this.P[0] += this.Q;
    this.P[1] += this.Q;
    this.P[2] += this.Q;
    this.P[3] += this.Q;
  }

  /**
   * Update step: incorporate new measurement
   * @param {number} measuredX - Measured x position
   * @param {number} measuredY - Measured y position
   */
  update(measuredX, measuredY) {
    if (!this.initialized) {
      this.state = [measuredX, measuredY, 0, 0];
      this.initialized = true;
      return;
    }

    // Calculate Kalman gain
    const Kx = this.P[0] / (this.P[0] + this.R);
    const Ky = this.P[1] / (this.P[1] + this.R);

    // Calculate innovation (measurement - prediction)
    const innovationX = measuredX - this.state[0];
    const innovationY = measuredY - this.state[1];

    // Update position state
    this.state[0] += Kx * innovationX;
    this.state[1] += Ky * innovationY;

    // Update velocity based on innovation
    const Kv = 0.5; // Velocity learning rate
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

/**
 * Applies Kalman filtering to all skeleton keypoints
 * @param {Array} poses - Array of pose objects from ml5
 * @returns {Array} Poses with smoothed keypoints
 *
 * Enhancement suggestions:
 * - Add per-joint filter tuning (hands need different smoothing than torso)
 * - Implement outlier rejection before filtering
 * - Add smoothness metrics for quality assessment
 */
function smoothKeypoints(poses) {
  if (!poses || !poses.length || !poses[0].keypoints) {
    kalmanFilters = [];
    return poses;
  }

  const currentKeypoints = poses[0].keypoints;

  // Initialize filters on first frame
  if (kalmanFilters.length !== currentKeypoints.length) {
    kalmanFilters = currentKeypoints.map(() =>
      new KalmanFilter2D(PROCESS_NOISE, MEASUREMENT_NOISE)
    );
  }

  // Apply filter to each keypoint
  const dt = 1 / 60; // Assume 60 FPS
  const smoothedKps = currentKeypoints.map((kp, i) => {
    const filter = kalmanFilters[i];

    filter.predict(dt);
    filter.update(kp.x, kp.y);

    const filtered = filter.getPosition();

    return {
      x: filtered.x,
      y: filtered.y,
      confidence: kp.confidence,
      name: kp.name
    };
  });

  return [{ ...poses[0], keypoints: smoothedKps }];
}

/* ===============================================================================
   SKELETON AND BODY VISUALIZATION
   =============================================================================== */

/**
 * Draws skeleton lines, keypoints, virtual chest, and facing arrow
 * @param {Array} poses - Smoothed pose data
 *
 * Enhancement suggestions:
 * - Add depth visualization (3D pose if available)
 * - Implement stylized skeleton rendering (neon, particles, etc.)
 * - Add gesture-specific visual effects
 * - Support custom bone coloring based on joint angles
 */
function drawSkeletonAndChest(poses) {
  const sX = width / video.width;
  const sY = height / video.height;

  stroke(255, 0, 0);
  strokeWeight(2);

  for (const pose of poses) {
    // Draw skeleton connections
    for (const [aIndex, bIndex] of connections) {
      const a = pose.keypoints[aIndex];
      const b = pose.keypoints[bIndex];
      if (confOK(a) && confOK(b)) {
        line(a.x * sX, a.y * sY, b.x * sX, b.y * sY);
      }
    }

    // Draw keypoints as circles
    noStroke();
    fill(0, 255, 0);
    for (const kp of pose.keypoints) {
      if (confOK(kp)) circle(kp.x * sX, kp.y * sY, 6);
    }

    // Calculate and draw virtual chest point
    const LS = getKP(pose, 'left_shoulder');
    const RS = getKP(pose, 'right_shoulder');
    const LH = getKP(pose, 'left_hip');
    const RH = getKP(pose, 'right_hip');

    if (LS && RS) {
      const shoulderMid = { x: (LS.x + RS.x) / 2, y: (LS.y + RS.y) / 2 };
      let chestX = shoulderMid.x, chestY = shoulderMid.y;

      // Refine chest position using hip midpoint
      if (LH && RH) {
        const hipMid = { x: (LH.x + RH.x) / 2, y: (LH.y + RH.y) / 2 };
        chestX = 0.7 * shoulderMid.x + 0.3 * hipMid.x;
        chestY = 0.7 * shoulderMid.y + 0.3 * hipMid.y;
      }
      chestX *= sX; chestY *= sY;

      // Draw chest point
      fill(0, 255, 255);
      noStroke();
      circle(chestX, chestY, 10);

      // Draw connectors from chest to shoulders and hips
      stroke(255);
      strokeWeight(2);
      line(chestX, chestY, LS.x * sX, LS.y * sY);
      line(chestX, chestY, RS.x * sX, RS.y * sY);
      if (LH) line(chestX, chestY, LH.x * sX, LH.y * sY);
      if (RH) line(chestX, chestY, RH.x * sX, RH.y * sY);

      // Draw facing direction arrow (perpendicular to shoulders)
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

/* ===============================================================================
   FLUID SIMULATION INTEGRATION
   =============================================================================== */

/**
 * Injects fluid splats at body keypoints based on their movement
 * @param {Array} posesArr - Current pose data
 * @param {number} dtSec - Delta time in seconds
 *
 * Enhancement suggestions:
 * - Add per-joint color mapping (hands = red, feet = blue, etc.)
 * - Support different splat patterns based on joint type
 * - Add "fluid trails" that persist longer for hand movements
 * - Implement gesture-triggered special effects (wave = burst, etc.)
 */
function injectBodySplats(posesArr, dtSec) {
  if (!posesArr || !posesArr.length || !fluidSim) return;

  const pose = posesArr[0];
  if (!pose.keypoints) return;

  const sX = width / video.width;
  const sY = height / video.height;

  // Define which keypoints create splats and their properties
  const splatPoints = [
    { name: 'left_wrist', radius: 1.0, force: 1.0 },   // Hands: strongest effect
    { name: 'right_wrist', radius: 1.0, force: 1.0 },
    { name: 'left_elbow', radius: 0.7, force: 0.6 },   // Elbows: medium effect
    { name: 'right_elbow', radius: 0.7, force: 0.6 },
    { name: 'nose', radius: 0.5, force: 0.4 },         // Head: subtle effect
    { name: 'left_shoulder', radius: 0.5, force: 0.3 }, // Shoulders: minimal
    { name: 'right_shoulder', radius: 0.5, force: 0.3 }
  ];

  // Get current color based on movement speed
  const rgb = hsbToRgb(hueNow, satNow, briNow);

  for (const pt of splatPoints) {
    const kp = getKP(pose, pt.name);
    if (!kp) continue;

    const x = kp.x * sX;
    const y = kp.y * sY;

    // Calculate velocity from previous frame
    let dx = 0, dy = 0;
    if (prevKeypoints[pt.name]) {
      dx = (x - prevKeypoints[pt.name].x) / Math.max(0.016, dtSec);
      dy = (y - prevKeypoints[pt.name].y) / Math.max(0.016, dtSec);
    }
    prevKeypoints[pt.name] = { x, y };

    // Only inject splat if there's significant movement
    const speed = Math.sqrt(dx * dx + dy * dy);
    if (speed > 5) {
      // Normalize coordinates for WebGL (0-1 range)
      const normX = x / width;
      const normY = y / height;

      // Scale force by speed and point importance
      const forceMult = Math.min(speed / 100, 3) * pt.force * (1 + spdLP2 * 2);

      injectSplat(
        fluidSim,
        normX,
        normY,
        dx,
        dy,
        { r: rgb.r * 0.8, g: rgb.g * 0.8, b: rgb.b * 0.8 },
        FLUID_CONFIG.SPLAT_RADIUS * pt.radius,
        forceMult * 0.5
      );
    }
  }
}

/* ===============================================================================
   MOTION TRACKING
   =============================================================================== */

/**
 * Measures overall body velocity by tracking multiple keypoints
 * @param {Array} posesArr - Current pose data
 * @param {number} dtSec - Delta time in seconds
 * @returns {number} Normalized velocity (0-1+ range)
 *
 * Enhancement suggestions:
 * - Add per-limb velocity tracking for detailed motion analysis
 * - Implement acceleration tracking for more reactive visuals
 * - Support different weighting schemes (upper body vs lower body)
 * - Add directional motion detection (moving left/right/up/down)
 */
function measureBodyVelocity(posesArr, dtSec) {
  if (!posesArr || !posesArr.length) { lastPts = null; return 0; }
  const pose = posesArr[0];
  if (!pose.keypoints || !pose.keypoints.length) { lastPts = null; return 0; }

  // Keypoints to track for velocity
  const names = [
    'nose',
    'left_shoulder', 'right_shoulder',
    'left_elbow', 'right_elbow',
    'left_wrist', 'right_wrist',
    'left_hip', 'right_hip',
    'left_knee', 'right_knee'
  ];

  const curr = [], conf = [];
  for (const nm of names) {
    const kp = getKP(pose, nm);
    if (kp) {
      curr.push({ x: kp.x, y: kp.y });
      conf.push(kp.confidence);
    }
  }
  if (curr.length < 4) { lastPts = null; return 0; }

  // Calculate weighted average displacement
  let disp = 0, wsum = 0;
  if (lastPts && lastPts.length === curr.length) {
    for (let i = 0; i < curr.length; i++) {
      const d = Math.hypot(curr[i].x - lastPts[i].x, curr[i].y - lastPts[i].y);
      const w = conf[i];
      disp += d * w;
      wsum += w;
    }
    if (wsum > 0) disp /= wsum;
  }
  lastPts = curr;

  // Convert to normalized velocity
  const pixPerSec = disp / max(0.001, dtSec);
  const diag = Math.hypot(width, height);
  return pixPerSec / (diag * 2.0);
}

/* ===============================================================================
   DEBUG AND UI
   =============================================================================== */

/**
 * Draws debug information overlay
 * @param {number} tLinear - Linear speed value (0-1)
 *
 * Enhancement suggestions:
 * - Add graphs for speed/color over time
 * - Display keypoint confidence scores
 * - Show fluid simulation statistics
 * - Add performance profiling data
 */
function drawDebugHUD(tLinear) {
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

/* ===============================================================================
   UTILITY FUNCTIONS
   =============================================================================== */

/**
 * Checks if a keypoint has sufficient confidence
 * @param {Object} kp - Keypoint object
 * @returns {boolean} True if confidence > 0.1
 */
function confOK(kp) {
  return kp && kp.confidence > 0.1;
}

/**
 * Finds a keypoint by name in a pose
 * @param {Object} pose - Pose object
 * @param {string} name - Keypoint name
 * @returns {Object|null} Keypoint or null if not found/low confidence
 */
function getKP(pose, name) {
  if (!pose || !pose.keypoints) return null;
  return pose.keypoints.find(k =>
    (k.name === name || k.part === name) && k.confidence > 0.1
  ) || null;
}

/**
 * Draws an arrow from one point to another
 * @param {p5.Vector} from - Start point
 * @param {p5.Vector} to - End point
 */
function drawArrow(from, to) {
  line(from.x, from.y, to.x, to.y);
  const v = p5.Vector.sub(to, from).normalize();
  const head = 10;
  const L = p5.Vector.add(to, p5.Vector.mult(rotate2D(v, radians(150)), head));
  const R = p5.Vector.add(to, p5.Vector.mult(rotate2D(v, radians(-150)), head));
  triangle(to.x, to.y, L.x, L.y, R.x, R.y);
}

/**
 * Rotates a 2D vector by an angle
 * @param {p5.Vector} v - Vector to rotate
 * @param {number} a - Angle in radians
 * @returns {p5.Vector} Rotated vector
 */
function rotate2D(v, a) {
  const c = cos(a), s = sin(a);
  return createVector(v.x * c - v.y * s, v.x * s + v.y * c);
}

/**
 * Interpolates between two hue values using shortest path around color wheel
 * @param {number} h1 - Start hue (0-360)
 * @param {number} h2 - End hue (0-360)
 * @param {number} a - Interpolation amount (0-1)
 * @returns {number} Interpolated hue
 *
 * Enhancement suggestions:
 * - Support different interpolation curves (ease-in, ease-out, etc.)
 * - Add saturation/brightness interpolation functions
 */
function lerpHue(h1, h2, a) {
  let dh = ((h2 - h1 + 540) % 360) - 180;
  return (h1 + dh * constrain(a, 0, 1) + 360) % 360;
}

/**
 * Quintic ease-out function for smooth, natural motion
 * @param {number} x - Input value (0-1)
 * @returns {number} Eased value (0-1)
 *
 * Enhancement suggestions:
 * - Add other easing functions (elastic, bounce, etc.)
 * - Support custom bezier curves
 */
function easeOutQuint(x) {
  x = constrain(x, 0, 1);
  return 1 - pow(1 - x, 5);
}

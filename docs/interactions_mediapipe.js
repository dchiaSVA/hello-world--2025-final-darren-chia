/*
 * ===============================================================================
 * BODY-DRIVEN INTERACTIVE VISUAL EXPERIENCE - MEDIAPIPE VERSION
 * ===============================================================================
 *
 * This version uses Google MediaPipe for improved performance and accuracy
 * compared to the ml5.js version.
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
 * - MediaPipe Pose (pose detection)
 * - MediaPipe SelfieSegmentation (body segmentation)
 * - fluid-simulation.js (WebGL fluid dynamics module - must be loaded first)
 *
 * ===============================================================================
 */

/* ===============================================================================
   GLOBAL VARIABLES
   =============================================================================== */

// Video and MediaPipe models
let videoElement;
let mpPose, mpSegmentation, mpCamera;
let poses = [];
let segmentationMask = null;
let videoReady = false;

// MediaPipe landmark connections (for skeleton drawing)
const POSE_CONNECTIONS = [
  [11, 12], // shoulders
  [11, 13], [13, 15], // left arm
  [12, 14], [14, 16], // right arm
  [11, 23], [12, 24], // torso
  [23, 24], // hips
  [23, 25], [25, 27], // left leg
  [24, 26], [26, 28], // right leg
];

// MediaPipe landmark name mapping (index to name)
const LANDMARK_NAMES = {
  0: 'nose',
  11: 'left_shoulder',
  12: 'right_shoulder',
  13: 'left_elbow',
  14: 'right_elbow',
  15: 'left_wrist',
  16: 'right_wrist',
  23: 'left_hip',
  24: 'right_hip',
  25: 'left_knee',
  26: 'right_knee',
  27: 'left_ankle',
  28: 'right_ankle'
};

/* ---------- Visual Configuration ---------- */
const SHOW_MASKED_VIDEO = true; // Whether to show segmented video (using MediaPipe Pose built-in segmentation)

// Internal rendering resolution (smaller for performance, centered on screen)
const RENDER_WIDTH = 960;
const RENDER_HEIGHT = 720;
let renderOffsetX = 0;  // Calculated in setup
let renderOffsetY = 0;

/* ---------- Color Palette (Yellow → Red) ---------- */
const RED_HUE   = 5;    // Fast movement hue (deep red)
const YEL_HUE   = 57;   // Idle/slow movement hue (bright yellow)
const SAT_MIN   = 85, SAT_MAX = 98; // Saturation range
const BRI_MIN   = 90, BRI_MAX = 100; // Brightness range

/* ---------- Motion Tracking Parameters ---------- */
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

/* ---------- Color Cycling Configuration ---------- */
let colorCycleOffset = 0;        // Current hue offset for cycling
const COLOR_CYCLE_SPEED = 0.5;  // How fast colors cycle (degrees per frame)

let lastPts = null; // Previous keypoint positions for velocity calculation
let lastTime = 0; // Previous frame timestamp
let frameCounter = 0; // Total frames rendered
let fps = 0, fpsUpdateTime = 0, fpsFrameCount = 0; // FPS tracking

/* ---------- Kalman Filter Configuration ---------- */
const PROCESS_NOISE = 0.8;    // Higher = less trust in predictions
const MEASUREMENT_NOISE = 1.5; // Lower = more trust in MediaPipe measurements
let kalmanFilters = [];

/* ---------- Segmentation Mask Smoothing ---------- */
const MASK_SES_ALPHA = 0.3; // 0.3-0.5 recommended, higher = more responsive
let smoothedMask = null;
let maskGraphics = null; // Off-screen graphics for mask processing

/* ---------- WebGL Fluid Simulation ---------- */
let fluidCanvas, gl; // Fluid canvas and WebGL context
let fluidSim = null; // Fluid simulation instance

// Track previous keypoint positions for velocity calculation
let prevKeypoints = {};

/* ---------- Performance Optimization ---------- */
let fluidUpdateCounter = 0;
const FLUID_UPDATE_SKIP = 0; // 0 = every frame, 1 = every other frame, etc.

/**
 * Fluid simulation configuration - optimized for performance
 */
const FLUID_CONFIG = {
  SIM_RESOLUTION: 192,          // Velocity field resolution (lower = faster)
  DYE_RESOLUTION: 256,          // Color field resolution (balanced quality/speed)
  DENSITY_DISSIPATION: 0.99,   // How fast colors fade (0.9-0.99, higher = longer trails)
  VELOCITY_DISSIPATION: 0.95,  // How fast motion dies down (0.9-0.99)
  PRESSURE_ITERATIONS: 8,       // Reduced iterations (still looks good)
  CURL: 40,                     // Vorticity confinement (swirl strength, 0-50)
  SPLAT_RADIUS: 0.15,          // Base size of fluid splats
  SPLAT_FORCE: 6000,           // Force multiplier for splats
  COLOR_UPDATE_SPEED: 10       // Unused - reserved for future color animation
};

/* ===============================================================================
   P5.JS LIFECYCLE FUNCTIONS
   =============================================================================== */

/**
 * p5.js preload function - MediaPipe loads asynchronously, so this is minimal
 */
function preload() {
  // MediaPipe loads asynchronously in setup, nothing to preload
}

/**
 * p5.js setup function - initializes canvas, video, and MediaPipe models
 */
function setup() {
  console.log('Setup starting...');

  // Performance: Use 1x pixel density (disable retina/HiDPI scaling)
  pixelDensity(1);

  // Fullscreen canvas (black background with centered render area)
  createCanvas(windowWidth, windowHeight);
  colorMode(HSB, 360, 100, 100, 100);

  // Calculate centered offset for render area
  renderOffsetX = (windowWidth - RENDER_WIDTH) / 2;
  renderOffsetY = (windowHeight - RENDER_HEIGHT) / 2;

  // Create off-screen graphics for mask processing
  maskGraphics = createGraphics(RENDER_WIDTH, RENDER_HEIGHT);

  // Get video element from HTML
  videoElement = document.getElementById('mediapipe-video');
  console.log('Video element:', videoElement);

  try {
    // Initialize MediaPipe Pose
    console.log('Initializing MediaPipe Pose...');
    mpPose = new Pose({
      locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`;
      }
    });

    mpPose.setOptions({
      modelComplexity: 1,        // 0=lite, 1=full, 2=heavy (accuracy vs speed)
      smoothLandmarks: true,     // Temporal smoothing
      enableSegmentation: true,  // Use MediaPipe's built-in segmentation (OPTION 1)
      smoothSegmentation: true,  // Smooth the segmentation mask over time
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    mpPose.onResults(onPoseResults);
    console.log('MediaPipe Pose initialized');

    // Note: We're using Pose's built-in segmentation (Option 1)
    // No need for separate SelfieSegmentation model

    // Initialize camera using MediaPipe Camera Utils
    console.log('Starting camera...');
    mpCamera = new Camera(videoElement, {
      onFrame: async () => {
        try {
          if (videoElement.readyState >= 2) {
            if (!videoReady) {
              console.log('Video ready! Starting detection...');
              videoReady = true;
            }
            // Only send to Pose (which now includes segmentation)
            await mpPose.send({ image: videoElement });
          }
        } catch (err) {
          console.error('Error in camera frame callback:', err);
        }
      },
      width: 640,   // Higher resolution than ml5 version (was 320x240)
      height: 480
    });

    mpCamera.start().then(() => {
      console.log('Camera started successfully');
    }).catch(err => {
      console.error('Failed to start camera:', err);
    });
  } catch (err) {
    console.error('Error during MediaPipe setup:', err);
  }

  lastTime = millis();

  // Initialize WebGL fluid simulation at smaller render size
  console.log('Initializing fluid simulation...');
  const fluidInit = initFluidSimulation(RENDER_WIDTH, RENDER_HEIGHT, FLUID_CONFIG);
  if (fluidInit) {
    fluidCanvas = fluidInit.canvas;
    gl = fluidInit.gl;
    fluidSim = fluidInit.sim;
    console.log('Fluid simulation initialized');
  } else {
    console.error('Failed to initialize fluid simulation');
  }

  console.log('Setup complete');
}

/**
 * Handle MediaPipe pose detection results
 */
function onPoseResults(results) {
  try {
    if (results.poseLandmarks) {
      // Convert MediaPipe format to ml5-compatible format
      const keypoints = results.poseLandmarks.map((landmark, index) => ({
        x: landmark.x * videoElement.videoWidth,
        y: landmark.y * videoElement.videoHeight,
        z: landmark.z, // MediaPipe provides depth!
        confidence: landmark.visibility || 0.5,
        name: LANDMARK_NAMES[index] || `landmark_${index}`
      }));

      poses = [{
        keypoints: keypoints,
        score: 1.0
      }];
    } else {
      poses = [];
    }

    // Get segmentation mask from Pose results (Option 1 - built-in)
    if (results.segmentationMask) {
      segmentationMask = results.segmentationMask;
    }
  } catch (err) {
    console.error('Error in onPoseResults:', err);
  }
}

/**
 * Handle MediaPipe segmentation results
 */
function onSegmentationResults(results) {
  try {
    if (results.segmentationMask) {
      segmentationMask = results.segmentationMask;
    }
  } catch (err) {
    console.error('Error in onSegmentationResults:', err);
  }
}

/**
 * Handle window resize - recalculate offsets (fluid stays same size)
 */
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);

  // Recalculate centered offset
  renderOffsetX = (windowWidth - RENDER_WIDTH) / 2;
  renderOffsetY = (windowHeight - RENDER_HEIGHT) / 2;
}

/**
 * Handles keyboard input for toggling features
 */
function keyPressed() {
  if (key === 'd' || key === 'D') showDebug = !showDebug;
  if (key === 's' || key === 'S') showSkeleton = !showSkeleton;
  if (key === 'f' || key === 'F') showFluid = !showFluid;
}

/**
 * Main draw loop - renders every frame
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

  // --- Render background (fluid or simple black) ---
  // All rendering is offset to the centered render area
  background(0); // Black background fills entire screen

  if (showFluid && fluidSim) {
    // Inject fluid splats at body keypoints
    injectBodySplats(poses, dtSec);

    // Update fluid simulation physics
    fluidSim.update();

    // Draw fluid to p5 canvas (centered)
    drawingContext.drawImage(fluidCanvas, renderOffsetX, renderOffsetY, RENDER_WIDTH, RENDER_HEIGHT);
  }

  // --- Render segmented person on top ---
  if (SHOW_MASKED_VIDEO && segmentationMask && videoReady) {
    drawSegmentedVideo();
  }

  // --- Render skeleton overlay (offset to render area) ---
  if (showSkeleton && poses && poses.length) {
    push();
    translate(renderOffsetX, renderOffsetY);
    const smoothed = smoothKeypoints(poses);
    drawSkeletonAndChest(smoothed, RENDER_WIDTH, RENDER_HEIGHT);
    pop();
  }

  // --- Debug HUD (top-left corner, not offset) ---
  if (showDebug) {
    drawDebugHUD(tLinear);
  }
}

/**
 * Draw the segmented video (person isolated from background)
 * Uses off-screen canvas with composite operations for better performance
 */
function drawSegmentedVideo() {
  if (!videoElement || !segmentationMask || videoElement.videoWidth === 0) return;

  try {
    // Clear the mask graphics buffer
    maskGraphics.clear();

    // Get the context of the off-screen buffer
    const ctx = maskGraphics.drawingContext;

    // Draw mirrored video first
    ctx.save();
    ctx.scale(-1, 1);
    ctx.translate(-RENDER_WIDTH, 0);
    ctx.drawImage(videoElement, 0, 0, RENDER_WIDTH, RENDER_HEIGHT);
    ctx.restore();

    // Use 'destination-in' to keep only the video where the mask is opaque
    ctx.globalCompositeOperation = 'destination-in';

    // Draw the segmentation mask (also mirrored to match video)
    ctx.save();
    ctx.scale(-1, 1);
    ctx.translate(-RENDER_WIDTH, 0);
    ctx.drawImage(segmentationMask, 0, 0, RENDER_WIDTH, RENDER_HEIGHT);
    ctx.restore();

    // Reset composite operation
    ctx.globalCompositeOperation = 'source-over';

    // Draw the masked result to the main canvas
    image(maskGraphics, renderOffsetX, renderOffsetY);
  } catch (err) {
    console.error('Error in drawSegmentedVideo:', err);
  }
}

/* ===============================================================================
   KALMAN FILTER FOR SKELETON SMOOTHING
   =============================================================================== */

/**
 * 2D Kalman Filter for tracking a point with velocity
 * State vector: [x, y, vx, vy]
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
 * @param {Array} poses - Array of pose objects
 * @returns {Array} Poses with smoothed keypoints
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
 * @param {number} renderW - Render area width (defaults to RENDER_WIDTH)
 * @param {number} renderH - Render area height (defaults to RENDER_HEIGHT)
 */
function drawSkeletonAndChest(poses, renderW = RENDER_WIDTH, renderH = RENDER_HEIGHT) {
  // MediaPipe coordinates are already normalized 0-1, then scaled to video dimensions
  const sX = renderW / videoElement.videoWidth;
  const sY = renderH / videoElement.videoHeight;

  stroke(255, 0, 0);
  strokeWeight(2);

  for (const pose of poses) {
    // Draw skeleton connections using MediaPipe connection indices
    for (const [aIndex, bIndex] of POSE_CONNECTIONS) {
      const a = pose.keypoints[aIndex];
      const b = pose.keypoints[bIndex];
      if (confOK(a) && confOK(b)) {
        // Mirror x-coordinate for display
        const ax = (videoElement.videoWidth - a.x) * sX;
        const bx = (videoElement.videoWidth - b.x) * sX;
        line(ax, a.y * sY, bx, b.y * sY);
      }
    }

    // Draw keypoints as circles
    noStroke();
    fill(0, 255, 0);
    for (const kp of pose.keypoints) {
      if (confOK(kp)) {
        const kx = (videoElement.videoWidth - kp.x) * sX;
        circle(kx, kp.y * sY, 6);
      }
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

      // Mirror and scale chest position
      chestX = (videoElement.videoWidth - chestX) * sX;
      chestY *= sY;

      // Draw chest point
      fill(0, 255, 255);
      noStroke();
      circle(chestX, chestY, 10);

      // Draw connectors from chest to shoulders and hips (mirrored)
      stroke(255);
      strokeWeight(2);
      line(chestX, chestY, (videoElement.videoWidth - LS.x) * sX, LS.y * sY);
      line(chestX, chestY, (videoElement.videoWidth - RS.x) * sX, RS.y * sY);
      if (LH) line(chestX, chestY, (videoElement.videoWidth - LH.x) * sX, LH.y * sY);
      if (RH) line(chestX, chestY, (videoElement.videoWidth - RH.x) * sX, RH.y * sY);

      // Draw facing direction arrow (perpendicular to shoulders)
      // Note: need to account for mirroring in the direction calculation
      const vS = createVector((LS.x - RS.x) * sX, (RS.y - LS.y) * sY); // Swapped for mirror
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
 */
function injectBodySplats(posesArr, dtSec) {
  if (!posesArr || !posesArr.length || !fluidSim || !videoReady) return;

  const pose = posesArr[0];
  if (!pose.keypoints) return;

  // Use render dimensions for fluid simulation
  const sX = RENDER_WIDTH / videoElement.videoWidth;
  const sY = RENDER_HEIGHT / videoElement.videoHeight;

  // Update color cycling offset
  colorCycleOffset = (colorCycleOffset + COLOR_CYCLE_SPEED) % 360;

  // Color palette (hex to RGB normalized 0-1):
  const PALETTE = {
    deepBlue: { r: 0.043, g: 0.122, b: 0.231 },
    fluidBlue: { r: 0.059, g: 0.298, b: 0.506 },
    cyanTeal: { r: 0.122, g: 0.643, b: 0.714 },
    brightWhite: { r: 0.898, g: 0.984, b: 1.0 }
  };

  // Define which keypoints create splats with palette colors
  const splatPoints = [
    { name: 'left_wrist', radius: 1.0, force: 1.0, color: 'brightWhite' },
    { name: 'right_wrist', radius: 1.0, force: 1.0, color: 'brightWhite' },
    { name: 'left_elbow', radius: 0.7, force: 0.6, color: 'cyanTeal' },
    { name: 'right_elbow', radius: 0.7, force: 0.6, color: 'cyanTeal' },
    { name: 'nose', radius: 0.5, force: 0.4, color: 'cyanTeal' },
    { name: 'left_shoulder', radius: 0.5, force: 0.3, color: 'fluidBlue' },
    { name: 'right_shoulder', radius: 0.5, force: 0.3, color: 'fluidBlue' },
    { name: 'left_knee', radius: 0.6, force: 0.5, color: 'fluidBlue' },
    { name: 'right_knee', radius: 0.6, force: 0.5, color: 'fluidBlue' },
    { name: 'left_hip', radius: 0.4, force: 0.3, color: 'deepBlue' },
    { name: 'right_hip', radius: 0.4, force: 0.3, color: 'deepBlue' }
  ];

  for (const pt of splatPoints) {
    const kp = getKP(pose, pt.name);
    if (!kp) continue;

    // Mirror x-coordinate for display consistency
    const x = (videoElement.videoWidth - kp.x) * sX;
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
      // Normalize coordinates for WebGL (0-1 range) using render dimensions
      const normX = x / RENDER_WIDTH;
      const normY = y / RENDER_HEIGHT;

      // Get color from palette for this body part
      const baseColor = PALETTE[pt.color];

      // Apply color cycling by rotating through palette with subtle hue shift
      const cycleT = colorCycleOffset / 360;
      const rgb = {
        r: baseColor.r + Math.sin(cycleT * Math.PI * 2) * 0.15,
        g: baseColor.g + Math.sin(cycleT * Math.PI * 2 + 2) * 0.15,
        b: baseColor.b + Math.sin(cycleT * Math.PI * 2 + 4) * 0.15
      };

      // Scale force by speed and point importance
      const forceMult = Math.min(speed / 100, 3) * pt.force * (1 + spdLP2 * 2);

      injectSplat(
        fluidSim,
        normX,
        normY,
        dx,
        dy,
        rgb,
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

  // Convert to normalized velocity using render dimensions
  const pixPerSec = disp / max(0.001, dtSec);
  const diag = Math.hypot(RENDER_WIDTH, RENDER_HEIGHT);
  return pixPerSec / (diag * 2.0);
}

/* ===============================================================================
   DEBUG AND UI
   =============================================================================== */

/**
 * Draws debug information overlay
 * @param {number} tLinear - Linear speed value (0-1)
 */
function drawDebugHUD(tLinear) {
  noStroke();
  fill(0, 0, 0, 65);
  rect(10, 10, 600, 140, 8);
  fill(0, 0, 100);
  textSize(12);
  text(`FPS: ${fps}  [MediaPipe Version]`, 20, 30);
  text(`speed raw:${spdRaw.toFixed(3)}  lp:${spdLP2.toFixed(3)}  t:${tLinear.toFixed(2)}`, 20, 46);
  text(`hue:${hueNow.toFixed(1)}  sat:${satNow.toFixed(0)}  bri:${briNow.toFixed(0)}  idle:${isIdle}`, 20, 62);
  text(`[D] HUD  [S] skeleton  [F] fluid:${showFluid}  gain:${SPEED_GAIN}  deadzone:${MOTION_DEADZONE}`, 20, 78);
  text(`Video: ${videoReady ? 'Ready' : 'Loading...'}  Poses: ${poses.length}`, 20, 94);
  text(`Segmentation: ${segmentationMask ? 'Active' : 'None'}  Fluid: ${fluidSim ? 'Active' : 'None'}`, 20, 110);
  if (!videoReady) {
    fill(100, 100, 100);
    text('Waiting for camera... Check browser console (F12) for errors', 20, 126);
  }
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
 */
function lerpHue(h1, h2, a) {
  let dh = ((h2 - h1 + 540) % 360) - 180;
  return (h1 + dh * constrain(a, 0, 1) + 360) % 360;
}

/**
 * Quintic ease-out function for smooth, natural motion
 * @param {number} x - Input value (0-1)
 * @returns {number} Eased value (0-1)
 */
function easeOutQuint(x) {
  x = constrain(x, 0, 1);
  return 1 - pow(1 - x, 5);
}

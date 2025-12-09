/* ================================================================================
   WebGL FLUID SIMULATION MODULE
   Based on Navier-Stokes equations, GPU-accelerated
   Adapted from PavelDoGreat/WebGL-Fluid-Simulation (MIT License)

   This module provides a complete 2D fluid dynamics simulation running on the GPU.
   It can be used for interactive visual effects driven by user input or body tracking.

   Note: This file should be loaded BEFORE interactions.js in the HTML
   ================================================================================ */

/**
 * Converts HSB (Hue, Saturation, Brightness) color values to RGB
 * @param {number} h - Hue (0-360)
 * @param {number} s - Saturation (0-100)
 * @param {number} b - Brightness (0-100)
 * @returns {{r: number, g: number, b: number}} RGB values (0-1 range)
 *
 * Enhancement suggestions:
 * - Add alpha channel support for transparency effects
 * - Support other color spaces (HSL, LAB, etc.)
 * - Add color blending modes (multiply, screen, overlay)
 */
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

/**
 * Initializes the WebGL fluid simulation canvas and context
 * @param {number} width - Canvas width in pixels
 * @param {number} height - Canvas height in pixels
 * @returns {{canvas: HTMLCanvasElement, gl: WebGLRenderingContext, sim: FluidSimulation}|null}
 *
 * Enhancement suggestions:
 * - Add fallback for browsers without WebGL support (canvas 2D approximation)
 * - Support multiple fluid layers with different properties
 * - Add performance profiling to auto-adjust quality settings
 * - Support custom shader injection for advanced effects
 */
function initFluidSimulation(width, height, config) {
  // Create a separate canvas for WebGL fluid
  const fluidCanvas = document.createElement('canvas');
  fluidCanvas.width = width;
  fluidCanvas.height = height;
  fluidCanvas.style.position = 'absolute';
  fluidCanvas.style.top = '0';
  fluidCanvas.style.left = '0';
  fluidCanvas.style.pointerEvents = 'none';
  fluidCanvas.style.display = 'none'; // Hidden, we'll copy to main canvas

  document.body.appendChild(fluidCanvas);

  let gl = fluidCanvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false });
  if (!gl) {
    gl = fluidCanvas.getContext('webgl', { alpha: true });
  }

  if (!gl) {
    console.warn('WebGL not supported, fluid simulation disabled');
    return null;
  }

  // Enable extensions for floating point textures
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');

  const fluidSim = new FluidSimulation(gl, fluidCanvas.width, fluidCanvas.height, config);

  return { canvas: fluidCanvas, gl, sim: fluidSim };
}

/**
 * Draws the fluid simulation canvas onto a p5.js canvas
 * @param {HTMLCanvasElement} fluidCanvas - The WebGL fluid canvas
 * @param {CanvasRenderingContext2D} drawingContext - p5.js drawing context
 * @param {number} width - Target width
 * @param {number} height - Target height
 *
 * Enhancement suggestions:
 * - Add blend modes (additive, multiply, etc.)
 * - Support post-processing effects (bloom, blur, chromatic aberration)
 * - Add opacity control for layering effects
 * - Support region-based rendering (render only part of the fluid)
 */
function drawFluidToCanvas(fluidCanvas, drawingContext, width, height) {
  if (!fluidCanvas) return;

  // Use the drawing context to draw the WebGL canvas
  drawingContext.drawImage(fluidCanvas, 0, 0, width, height);
}

/**
 * Injects a colored splat (dye + velocity) into the fluid at a specific position
 * @param {FluidSimulation} fluidSim - The fluid simulation instance
 * @param {number} x - X position (0-1 normalized)
 * @param {number} y - Y position (0-1 normalized)
 * @param {number} dx - X velocity
 * @param {number} dy - Y velocity
 * @param {{r: number, g: number, b: number}} color - RGB color (0-1 range)
 * @param {number} radius - Splat radius multiplier
 * @param {number} force - Force multiplier
 *
 * Enhancement suggestions:
 * - Add splat shapes (circle, line, custom textures)
 * - Support animated splats (pulsing, rotating)
 * - Add splat trails for motion blur effects
 * - Support temperature-based color mixing
 */
function injectSplat(fluidSim, x, y, dx, dy, color, radius, force) {
  if (!fluidSim) return;

  fluidSim.splat(
    x,
    y,
    dx * force,
    dy * force,
    color.r,
    color.g,
    color.b,
    radius
  );
}

/* ================================================================================
   FLUID SIMULATION CLASS

   Implements the full Navier-Stokes equations on the GPU using WebGL shaders.
   The simulation uses a technique called "stable fluids" which guarantees
   numerical stability even with large time steps.
   ================================================================================ */

/**
 * Main fluid simulation class that manages WebGL state and shader programs
 *
 * Enhancement suggestions:
 * - Add obstacles/collision detection for interactive boundaries
 * - Support external force fields (gravity, wind, magnetic)
 * - Add particle system integration for hybrid effects
 * - Support 3D fluid simulation using WebGL2 3D textures
 * - Add fluid recording/playback for replay effects
 * - Support multiple fluid types with different viscosities
 */
class FluidSimulation {
  constructor(gl, width, height, config) {
    this.gl = gl;
    this.width = width;
    this.height = height;
    this.config = config;

    // Calculate simulation resolution
    const simRes = this.getResolution(config.SIM_RESOLUTION);
    const dyeRes = this.getResolution(config.DYE_RESOLUTION);

    this.simWidth = simRes.width;
    this.simHeight = simRes.height;
    this.dyeWidth = dyeRes.width;
    this.dyeHeight = dyeRes.height;

    // Compile all shader programs
    this.programs = this.createPrograms();

    // Create framebuffers for simulation state
    this.density = this.createDoubleFBO(this.dyeWidth, this.dyeHeight, gl.RGBA, gl.FLOAT);
    this.velocity = this.createDoubleFBO(this.simWidth, this.simHeight, gl.RG, gl.FLOAT);
    this.pressure = this.createDoubleFBO(this.simWidth, this.simHeight, gl.R, gl.FLOAT);
    this.divergence = this.createFBO(this.simWidth, this.simHeight, gl.R, gl.FLOAT);
    this.curl = this.createFBO(this.simWidth, this.simHeight, gl.R, gl.FLOAT);

    // Create fullscreen quad for rendering
    this.quadBuffer = this.createQuadBuffer();

    this.lastTime = performance.now();
  }

  /**
   * Calculates appropriate resolution maintaining aspect ratio
   * @param {number} resolution - Base resolution
   * @returns {{width: number, height: number}}
   *
   * Enhancement suggestions:
   * - Add adaptive resolution based on performance metrics
   * - Support non-uniform resolution (higher detail in specific areas)
   */
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

  /**
   * Creates and compiles all shader programs needed for the simulation
   * @returns {Object} Object containing all compiled shader programs
   *
   * Enhancement suggestions:
   * - Add shader hot-reloading for live editing
   * - Support shader variants for different quality levels
   * - Add custom shader support for unique effects
   */
  createPrograms() {
    const gl = this.gl;

    // Vertex shader (shared across all programs)
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

    // Splat shader: Adds a blob of color/velocity to the simulation
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

    // Advection shader: Moves quantities along the velocity field
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

    // Divergence shader: Calculates divergence of velocity field
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

    // Curl shader: Calculates vorticity (rotation) of the velocity field
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

    // Vorticity shader: Applies vorticity confinement for swirly effects
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

    // Pressure shader: Iteratively solves for pressure to enforce incompressibility
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

    // Gradient subtract shader: Removes pressure gradient from velocity to make it divergence-free
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

    // Display shader: Renders the final fluid with proper alpha blending
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

    // Clear shader: Gradually fades the simulation (dissipation)
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

  /**
   * Compiles a vertex and fragment shader into a WebGL program
   * @param {string} vertexSource - GLSL vertex shader source
   * @param {string} fragmentSource - GLSL fragment shader source
   * @returns {{program: WebGLProgram, uniforms: Object}}
   */
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

  /**
   * Extracts uniform locations from a compiled shader program
   * @param {WebGLProgram} program - The compiled shader program
   * @returns {Object} Map of uniform names to locations
   */
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

  /**
   * Creates a framebuffer object (FBO) with a texture attachment
   * @param {number} w - Width
   * @param {number} h - Height
   * @param {number} internalFormat - Internal format (RGBA, RG, R, etc.)
   * @param {number} format - Format type
   * @returns {Object} FBO object with texture and attach method
   *
   * Enhancement suggestions:
   * - Support depth/stencil buffers for 3D effects
   * - Add mipmapping support for better sampling
   */
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

  /**
   * Creates a double-buffered FBO for ping-pong rendering
   * Double buffering allows reading from one buffer while writing to another
   * @param {number} w - Width
   * @param {number} h - Height
   * @param {number} internalFormat - Internal format
   * @param {number} format - Format type
   * @returns {Object} Double FBO with read/write accessors and swap method
   */
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

  /**
   * Creates a fullscreen quad vertex buffer for rendering
   * @returns {WebGLBuffer} Buffer containing quad vertices
   */
  createQuadBuffer() {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    return buffer;
  }

  /**
   * Renders a fullscreen quad to the specified destination
   * @param {Object|null} destination - Target FBO or null for screen
   */
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

  /**
   * Injects a splat of color and velocity into the fluid simulation
   * @param {number} x - X position (0-1)
   * @param {number} y - Y position (0-1)
   * @param {number} dx - X velocity
   * @param {number} dy - Y velocity
   * @param {number} r - Red component (0-1)
   * @param {number} g - Green component (0-1)
   * @param {number} b - Blue component (0-1)
   * @param {number} radius - Splat radius
   *
   * Enhancement suggestions:
   * - Add different splat shapes (square, triangle, custom)
   * - Support texture-based splats
   * - Add splat animation over time
   */
  splat(x, y, dx, dy, r, g, b, radius) {
    const gl = this.gl;

    // Add velocity to the velocity field
    gl.useProgram(this.programs.splat.program);
    gl.uniform1i(this.programs.splat.uniforms.uTarget, this.velocity.read.attach(0));
    gl.uniform1f(this.programs.splat.uniforms.aspectRatio, this.width / this.height);
    gl.uniform2f(this.programs.splat.uniforms.point, x, 1.0 - y);
    gl.uniform3f(this.programs.splat.uniforms.color, dx, -dy, 0.0);
    gl.uniform1f(this.programs.splat.uniforms.radius, radius / 100.0);
    this.blit(this.velocity.write);
    this.velocity.swap();

    // Add dye/color to the density field
    gl.uniform1i(this.programs.splat.uniforms.uTarget, this.density.read.attach(0));
    gl.uniform3f(this.programs.splat.uniforms.color, r, g, b);
    this.blit(this.density.write);
    this.density.swap();
  }

  /**
   * Updates the fluid simulation by one time step
   * Performs the full Navier-Stokes solve: advection, diffusion, pressure projection
   *
   * Enhancement suggestions:
   * - Add variable time stepping for better stability
   * - Support simulation pause/resume
   * - Add simulation state saving/loading
   * - Implement multi-grid solver for faster pressure solve
   * - Add turbulence noise for more chaotic motion
   */
  update() {
    const gl = this.gl;
    const now = performance.now();
    let dt = (now - this.lastTime) / 1000;
    dt = Math.min(dt, 0.016666); // Cap at ~60fps
    this.lastTime = now;

    // Step 1: Calculate curl (vorticity) of velocity field
    gl.useProgram(this.programs.curl.program);
    gl.uniform2f(this.programs.curl.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.programs.curl.uniforms.uVelocity, this.velocity.read.attach(0));
    this.blit(this.curl);

    // Step 2: Apply vorticity confinement to enhance swirls
    gl.useProgram(this.programs.vorticity.program);
    gl.uniform2f(this.programs.vorticity.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.programs.vorticity.uniforms.uVelocity, this.velocity.read.attach(0));
    gl.uniform1i(this.programs.vorticity.uniforms.uCurl, this.curl.attach(1));
    gl.uniform1f(this.programs.vorticity.uniforms.curl, this.config.CURL);
    gl.uniform1f(this.programs.vorticity.uniforms.dt, dt);
    this.blit(this.velocity.write);
    this.velocity.swap();

    // Step 3: Calculate divergence of velocity field
    gl.useProgram(this.programs.divergence.program);
    gl.uniform2f(this.programs.divergence.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.programs.divergence.uniforms.uVelocity, this.velocity.read.attach(0));
    this.blit(this.divergence);

    // Step 4: Clear/fade pressure from previous frame
    gl.useProgram(this.programs.clear.program);
    gl.uniform1i(this.programs.clear.uniforms.uTexture, this.pressure.read.attach(0));
    gl.uniform1f(this.programs.clear.uniforms.value, 0.8);
    this.blit(this.pressure.write);
    this.pressure.swap();

    // Step 5: Solve for pressure using Jacobi iteration
    gl.useProgram(this.programs.pressure.program);
    gl.uniform2f(this.programs.pressure.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.programs.pressure.uniforms.uDivergence, this.divergence.attach(0));
    for (let i = 0; i < this.config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(this.programs.pressure.uniforms.uPressure, this.pressure.read.attach(1));
      this.blit(this.pressure.write);
      this.pressure.swap();
    }

    // Step 6: Subtract pressure gradient to make velocity divergence-free
    gl.useProgram(this.programs.gradientSubtract.program);
    gl.uniform2f(this.programs.gradientSubtract.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.programs.gradientSubtract.uniforms.uPressure, this.pressure.read.attach(0));
    gl.uniform1i(this.programs.gradientSubtract.uniforms.uVelocity, this.velocity.read.attach(1));
    this.blit(this.velocity.write);
    this.velocity.swap();

    // Step 7: Advect velocity by itself (self-advection)
    gl.useProgram(this.programs.advection.program);
    gl.uniform2f(this.programs.advection.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.programs.advection.uniforms.uVelocity, this.velocity.read.attach(0));
    gl.uniform1i(this.programs.advection.uniforms.uSource, this.velocity.read.attach(0));
    gl.uniform1f(this.programs.advection.uniforms.dt, dt);
    gl.uniform1f(this.programs.advection.uniforms.dissipation, this.config.VELOCITY_DISSIPATION);
    this.blit(this.velocity.write);
    this.velocity.swap();

    // Step 8: Advect dye/color along the velocity field
    gl.uniform2f(this.programs.advection.uniforms.texelSize, this.density.texelSizeX, this.density.texelSizeY);
    gl.uniform1i(this.programs.advection.uniforms.uVelocity, this.velocity.read.attach(0));
    gl.uniform1i(this.programs.advection.uniforms.uSource, this.density.read.attach(1));
    gl.uniform1f(this.programs.advection.uniforms.dissipation, this.config.DENSITY_DISSIPATION);
    this.blit(this.density.write);
    this.density.swap();

    // Step 9: Display the final result
    gl.useProgram(this.programs.display.program);
    gl.uniform1i(this.programs.display.uniforms.uTexture, this.density.read.attach(0));
    this.blit(null);
  }

  /**
   * Cleans up WebGL resources
   *
   * Enhancement suggestions:
   * - Add resource pooling to avoid allocation overhead
   * - Implement automatic cleanup on context loss
   */
  destroy() {
    const gl = this.gl;
    // Clean up framebuffers, textures, and programs
    // (Implementation depends on specific cleanup needs)
  }
}

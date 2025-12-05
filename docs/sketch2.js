/*
Magical trail shader with ML5 Hand Tracking

Author:
  Jason Labbe

Site:
  jasonlabbe3d.com

Controls:
	- Move your hand to create particles.
	- Make a fist to fade away particles.
*/

// If you get an error about max uniforms then you can decrease these 2 values :(
const MAX_PARTICLE_COUNT = 70;
const MAX_TRAIL_COUNT = 30;

var colorScheme = ["#E69F66", "#DF843A", "#D8690F", "#B1560D", "#8A430A"];
var theShader;
var shaderTexture;
var trail = [];
var particles = [];

// ML5 Hand Tracking
let video;
let handPose;
let hands = [];
let handX = 0;
let handY = 0;
let prevHandX = 0;
let prevHandY = 0;
let isFist = false;
let modelReady = false;

function setup() {
	pixelDensity(1);
	
	// Setup ML5 Hand Tracking first to get video dimensions
	video = createCapture(VIDEO);
	video.size(640, 480);
	video.hide();
	
	// Create canvas matching video resolution
  createCanvas(640, 480, WEBGL);
	
	noCursor();
	
	shaderTexture = createGraphics(width, height, WEBGL);
	shaderTexture.noStroke();
	
	// Create shader after graphics are initialized
	theShader = shaderTexture.createShader(vertShader, fragShader);
	
	handPose = ml5.handPose(video, modelLoaded);
}

function modelLoaded() {
	console.log("Hand tracking model loaded!");
	modelReady = true;
	handPose.detectStart(video, gotHands);
}

function gotHands(results) {
	hands = results;
	
	if (hands.length > 0) {
		// Get index finger tip position (landmark 8)
		let indexTip = hands[0].keypoints[8];
		
		// Scale from video coordinates to canvas coordinates
		prevHandX = handX;
		prevHandY = handY;
		handX = (width - (indexTip.x * width / video.width));  // Flip and scale horizontal
		handY = (indexTip.y * height / video.height);          // Scale vertical
		
		// Detect fist: check if fingertips are close to palm
		let palm = hands[0].keypoints[0];
		let avgDistance = 0;
		// Check index, middle, ring, pinky tips (8, 12, 16, 20)
		[8, 12, 16, 20].forEach(idx => {
			let tip = hands[0].keypoints[idx];
			avgDistance += dist(tip.x, tip.y, palm.x, palm.y);
		});
		avgDistance /= 4;
		
		// If average distance is small, it's a fist
		isFist = avgDistance < 80;
	}
}

function draw() {
	background(0);
	noStroke();
	
	// Use hand position or mouse as fallback
	let currentX = hands.length > 0 ? handX : mouseX;
	let currentY = hands.length > 0 ? handY : mouseY;
	let prevX = hands.length > 0 ? prevHandX : pmouseX;
	let prevY = hands.length > 0 ? prevHandY : pmouseY;
	
	// Trim end of trail.
	trail.push([currentX, currentY]);
	
	let removeCount = 1;
	if (isFist) {  // Fist acts like middle mouse button
		removeCount++;
	}
	
	for (let i = 0; i < removeCount; i++) {
		if (trail.length == 0) {
			break;
		}
		
		if (isFist || trail.length > MAX_TRAIL_COUNT) {
			trail.splice(0, 1);
		}
	}
	
	// Spawn particles (works with both hand and mouse)
	if (trail.length > 1 && particles.length < MAX_PARTICLE_COUNT) {
		let movement = new p5.Vector(currentX, currentY);
		movement.sub(prevX, prevY);
		if (movement.mag() > 10) {
			movement.normalize();
			particles.push(new Particle(prevX, prevY, movement.x, movement.y));
		}
	}
	
	translate(-width / 2, -height / 2);
	
	// Move and kill particles.
	for (let i = particles.length - 1; i > -1; i--) {
		particles[i].move();
		if (particles[i].vel.mag() < 0.1) {
			particles.splice(i, 1);
		}
	}
	
	// Display shader.
	shaderTexture.shader(theShader);
	
	let data = serializeSketch();

	theShader.setUniform("resolution", [width, height]);
	theShader.setUniform("trailCount", trail.length);
	theShader.setUniform("trail", data.trails);
	theShader.setUniform("particleCount", particles.length);
	theShader.setUniform("particles", data.particles);
	theShader.setUniform("colors", data.colors);

	shaderTexture.rect(0, 0, width, height);
	texture(shaderTexture);
	
	rect(0, 0, width, height);
	
	// Draw hand tracking visualization
	if (hands.length > 0) {
		push();
		translate(-width / 2, -height / 2);
		
		// Draw all hand keypoints in white (small dots)
		fill(255, 255, 255, 150);
		noStroke();
		for (let kp of hands[0].keypoints) {
			let x = width - (kp.x * width / video.width);   // Flip and scale horizontal
			let y = kp.y * height / video.height;           // Scale vertical
			circle(x, y, 5);
		}
		
		// Draw red dot at index finger tip (larger)
		fill(255, 0, 0);
		circle(handX, handY, 20);
		
		// Draw green circle if fist detected
		if (isFist) {
			stroke(0, 255, 0);
			strokeWeight(3);
			noFill();
			circle(handX, handY, 40);
		}
		pop();
	}
}

function serializeSketch() {
	data = {"trails": [], "particles": [], "colors": []};
	
	for (let i = 0; i < trail.length; i++) {
		data.trails.push(
			map(trail[i][0], 0, width, 0.0, 1.0),
			map(trail[i][1], 0, height, 1.0, 0.0));
	}
	
	for (let i = 0; i < particles.length; i++) {
		data.particles.push(
			map(particles[i].pos.x, 0, width, 0.0, 1.0), 
			map(particles[i].pos.y, 0, height, 1.0, 0.0),
			particles[i].mass * particles[i].vel.mag() / 100)

		let itsColor = colorScheme[particles[i].colorIndex];
		data.colors.push(red(itsColor), green(itsColor), blue(itsColor));
	}
	
	return data;
}

function Particle(x, y, vx, vy) {
	this.pos = new p5.Vector(x, y);
	this.vel = new p5.Vector(vx, vy);
	this.vel.mult(random(10));
	this.vel.rotate(radians(random(-25, 25)));
	this.mass = random(1, 20);
	this.airDrag = random(0.92, 0.98);
	this.colorIndex = int(random(colorScheme.length));
	
	this.move = function() {
		this.vel.mult(this.airDrag);
		this.pos.add(this.vel);
	}
}

let vertShader = `
	precision highp float;

	attribute vec3 aPosition;

	void main() {
		vec4 positionVec4 = vec4(aPosition, 1.0);
		positionVec4.xy = positionVec4.xy * 2.0 - 1.0;
		gl_Position = positionVec4;
	}
`;

let fragShader = `
	precision highp float;
	
	uniform vec2 resolution;
	uniform int trailCount;
	uniform vec2 trail[${MAX_TRAIL_COUNT}];
	uniform int particleCount;
	uniform vec3 particles[${MAX_PARTICLE_COUNT}];
	uniform vec3 colors[${MAX_PARTICLE_COUNT}];

	void main() {
			vec2 st = gl_FragCoord.xy / resolution.xy;  // Warning! This is causing non-uniform scaling.

			float r = 0.0;
			float g = 0.0;
			float b = 0.0;

			for (int i = 0; i < ${MAX_TRAIL_COUNT}; i++) {
				if (i < trailCount) {
					vec2 trailPos = trail[i];
					float value = float(i) / distance(st, trailPos.xy) * 0.00015;  // Multiplier may need to be adjusted if max trail count is tweaked.
					g += value * 0.5;
					b += value;
				}
			}

			float mult = 0.00005;
			
			for (int i = 0; i < ${MAX_PARTICLE_COUNT}; i++) {
				if (i < particleCount) {
					vec3 particle = particles[i];
					vec2 pos = particle.xy;
					float mass = particle.z;
					vec3 color = colors[i];

					r += color.r / distance(st, pos) * mult * mass;
					g += color.g / distance(st, pos) * mult * mass;
					b += color.b / distance(st, pos) * mult * mass;
				}
			}

			gl_FragColor = vec4(r, g, b, 1.0);
	}
`;
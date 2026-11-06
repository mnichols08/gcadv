// The 3D view: one textured terrain mesh and a position marker. It draws only when something
// changed, because a phone rendering continuously on a long hike would run out of battery.
import { buildMesh, cameraEye, clampCamera, defaultCamera, groundFeet, HEIGHT_SCALE, lookAt, multiply, perspective, toWorld } from './terrain.js';

const SKY = [0.87, 0.91, 0.93];

const TERRAIN_VERTEX = `#version 300 es
uniform mat4 viewProjection;
in vec3 position;
in vec2 uv;
in float shade;
out vec2 vUv;
out float vShade;
out float vDistance;
void main() {
  vUv = uv;
  vShade = shade;
  gl_Position = viewProjection * vec4(position, 1.0);
  vDistance = gl_Position.w;
}`;

const TERRAIN_FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D drape;
uniform vec3 sky;
uniform float fogFar;
in vec2 vUv;
in float vShade;
in float vDistance;
out vec4 color;
void main() {
  vec3 ground = texture(drape, vUv).rgb * (0.62 + 0.62 * vShade);
  color = vec4(mix(ground, sky, smoothstep(fogFar * 0.45, fogFar, vDistance)), 1.0);
}`;

const MARKER_VERTEX = `#version 300 es
uniform mat4 viewProjection;
uniform vec3 place;
uniform float pixels;
void main() {
  gl_Position = viewProjection * vec4(place, 1.0);
  gl_PointSize = pixels;
}`;

const MARKER_FRAGMENT = `#version 300 es
precision mediump float;
out vec4 color;
void main() {
  float reach = length(gl_PointCoord - 0.5) * 2.0;
  if (reach > 1.0) discard;
  color = reach > 0.68 ? vec4(1.0) : vec4(0.04, 0.42, 1.0, 1.0);
}`;

function compile(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Shader failed');
  return program;
}

export class TerrainView {
  constructor(canvas, { onCameraChange, onContextLost }) {
    this.canvas = canvas;
    this.onCameraChange = onCameraChange;
    this.gl = canvas.getContext('webgl2', { antialias: true, powerPreference: 'low-power' });
    if (!this.gl) throw new Error('WebGL2 unavailable');
    const { gl } = this;
    this.terrainProgram = compile(gl, TERRAIN_VERTEX, TERRAIN_FRAGMENT);
    this.markerProgram = compile(gl, MARKER_VERTEX, MARKER_FRAGMENT);
    this.vao = gl.createVertexArray();
    this.vertexBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.texture = gl.createTexture();
    this.markerVao = gl.createVertexArray();
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
    this.camera = defaultCamera();
    this.grid = null;
    this.indexCount = 0;
    this.hasDrape = false;
    this.focus = null;
    this.marker = null;
    this.pointers = new Map();
    this.drawQueued = false;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      onContextLost?.();
    });
    new ResizeObserver(() => this.requestDraw()).observe(canvas);
    this.listen();
  }

  setGrid(grid) {
    const { gl } = this;
    this.grid = grid;
    const { vertices, indices } = buildMesh(grid);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    const attribute = (name, size, offset) => {
      const location = gl.getAttribLocation(this.terrainProgram, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 24, offset);
    };
    attribute('position', 3, 0);
    attribute('uv', 2, 12);
    attribute('shade', 1, 20);
    gl.bindVertexArray(null);
    this.indexCount = indices.length;
    this.hasDrape = false;
    this.requestDraw();
  }

  // The drape is an ordinary 2D canvas holding the topo map and everything drawn on it.
  setDrape(canvas) {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.anisotropy) gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, 4);
    this.hasDrape = true;
    this.requestDraw();
  }

  worldPoint(lat, lon) {
    const { x, z } = toWorld(this.grid, lat, lon);
    const ground = groundFeet(this.grid, x, z);
    return ground === null ? null : { x, y: ground * HEIGHT_SCALE, z };
  }

  // The camera orbits this point. Off-data points keep the previous focus.
  setFocus(lat, lon) {
    const point = this.grid && this.worldPoint(lat, lon);
    if (point) this.focus = point;
    this.requestDraw();
  }

  setMarker(lat, lon) {
    this.marker = this.grid ? this.worldPoint(lat, lon) : null;
    this.requestDraw();
  }

  setCamera(next) {
    this.camera = clampCamera({ ...this.camera, ...next });
    this.onCameraChange?.(this.camera);
    this.requestDraw();
  }

  zoomBy(factor) {
    this.setCamera({ distance: this.camera.distance * factor });
  }

  requestDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  draw() {
    const { gl, canvas, grid, focus } = this;
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    // Capped because terrain has no fine edges to justify the battery cost of full resolution.
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(box.width * ratio);
    const height = Math.round(box.height * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(...SKY, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!grid || !focus || !this.hasDrape) return;
    const eye = cameraEye(this.camera, focus, (x, z) => groundFeet(grid, x, z));
    const extent = grid.span * grid.feetPerTile;
    const far = Math.max(extent * 1.6, this.camera.distance * 2);
    const viewProjection = multiply(perspective(50, width / height, Math.max(50, this.camera.distance / 60), far), lookAt(eye, focus));

    gl.useProgram(this.terrainProgram);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.terrainProgram, 'viewProjection'), false, viewProjection);
    gl.uniform3f(gl.getUniformLocation(this.terrainProgram, 'sky'), ...SKY);
    gl.uniform1f(gl.getUniformLocation(this.terrainProgram, 'fogFar'), far);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(gl.getUniformLocation(this.terrainProgram, 'drape'), 0);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

    if (this.marker) {
      // Drawn over the ground on purpose: losing yourself behind a ridge helps no one.
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.markerProgram);
      gl.bindVertexArray(this.markerVao);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.markerProgram, 'viewProjection'), false, viewProjection);
      gl.uniform3f(gl.getUniformLocation(this.markerProgram, 'place'), this.marker.x, this.marker.y, this.marker.z);
      gl.uniform1f(gl.getUniformLocation(this.markerProgram, 'pixels'), 24 * ratio);
      gl.drawArrays(gl.POINTS, 0, 1);
      gl.enable(gl.DEPTH_TEST);
    }
    gl.bindVertexArray(null);
  }

  listen() {
    const { canvas } = this;
    const spread = () => {
      const [a, b] = [...this.pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y) || 1;
    };
    canvas.addEventListener('pointerdown', event => {
      canvas.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 2) this.pinch = { spread: spread(), distance: this.camera.distance };
    });
    canvas.addEventListener('pointermove', event => {
      const previous = this.pointers.get(event.pointerId);
      if (!previous) return;
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 1) {
        // Drag sideways to turn, up and down to look flatter or steeper.
        this.setCamera({ heading: this.camera.heading - dx * 0.4, tilt: this.camera.tilt + dy * 0.3 });
      } else if (this.pointers.size === 2 && this.pinch) {
        this.setCamera({ distance: this.pinch.distance * (this.pinch.spread / spread()) });
      }
    });
    const lift = event => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
    };
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      this.zoomBy(2 ** (event.deltaY / 300));
    }, { passive: false });
  }
}

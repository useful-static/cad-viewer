// Orbit-camera math, pure (no DOM) so tests/test-camera.mjs can check it in Node.
// cam: { target:[x,y,z], dist, yaw, pitch, fov, up:'y'|'z' }

// Unit vector from the orbit target to the eye.
export function camDir(cam) {
  const cp = Math.cos(cam.pitch);
  return cam.up === 'z'
    ? [cp * Math.sin(cam.yaw), -cp * Math.cos(cam.yaw), Math.sin(cam.pitch)]
    : [cp * Math.sin(cam.yaw), Math.sin(cam.pitch), cp * Math.cos(cam.yaw)];
}

// Screen-up vector. Away from the poles it is the world up axis. Within 0.07 rad
// of a pole (where world-up is nearly parallel to the view and lookAt degenerates)
// it is the limit of the projected world-up: -horizontal(yaw) over the TOP pole,
// +horizontal(yaw) under the BOTTOM one -- the sign follows pitch, so orbiting
// through either pole region never rolls the image.
export function camUp(cam) {
  if (Math.abs(cam.pitch) <= 1.5) return cam.up === 'z' ? [0, 0, 1] : [0, 1, 0];
  const s = cam.pitch > 0 ? -1 : 1;
  return cam.up === 'z'
    ? [s * Math.sin(cam.yaw), -s * Math.cos(cam.yaw), 0]
    : [s * Math.sin(cam.yaw), 0, s * Math.cos(cam.yaw)];
}

// Distance from target to eye actually used for rendering. In perspective it is
// cam.dist. In ortho, cam.dist only sets the SCALE; the eye is pushed back
// outside the model's bounding sphere, so zooming an ortho view in magnifies it
// and never puts the eye (and the near plane) inside the model.
export function eyeDist(cam, sphere) {
  if (!cam.ortho || !sphere) return cam.dist;
  const d = camDir(cam);
  const t = (sphere.center[0] - cam.target[0]) * d[0] + (sphere.center[1] - cam.target[1]) * d[1] + (sphere.center[2] - cam.target[2]) * d[2];
  return Math.max(cam.dist, t + sphere.radius * 1.1);
}

export function eyeOf(cam, sphere) {
  const d = camDir(cam);
  const r = eyeDist(cam, sphere);
  return [0, 1, 2].map((k) => cam.target[k] + d[k] * r);
}

// Orbit distance that frames a sphere of `radius` in BOTH directions: the
// narrower of the vertical and horizontal half-angles governs (a tall, narrow
// canvas is limited horizontally).
export function fitDistance(radius, fov, aspect) {
  const half = Math.min(fov / 2, Math.atan(Math.tan(fov / 2) * (aspect > 0 ? aspect : 1)));
  return (radius / Math.sin(half)) * 1.05;
}

// Near/far planes that contain the whole model from wherever the eye is, after
// any pan or zoom: bound the model by its bounding sphere (center, radius) and
// measure from the eye, not from the orbit target. The near floor scales with
// the orbit distance, so zooming onto a small part does not cut it.
// Depth planes are measured along the VIEW AXIS, so the sphere's depth range is
// its center's projected depth +- radius (a straight-line eye-center distance
// overstates it when the model is off-axis, which clipped the near side).
export function nearFar(cam, sphere) {
  const e = eyeOf(cam, sphere);
  const d = camDir(cam); // target -> eye; the view looks along -d
  const depth = -((sphere.center[0] - e[0]) * d[0] + (sphere.center[1] - e[1]) * d[1] + (sphere.center[2] - e[2]) * d[2]);
  // Perspective depth precision wants near far from the eye, so its floor
  // scales with the distance. Ortho depth is linear (no such need), and its eye
  // sits only 0.1 radius before the model: a distance-scaled floor there grows
  // with a panned-off target's depth and cut the model's front.
  const floor = cam.ortho
    ? Math.max(sphere.radius * 1e-3, 1e-6)
    : Math.max(eyeDist(cam, sphere) * 0.01, sphere.radius * 1e-6, 1e-6);
  const near = Math.max(depth - sphere.radius * 1.01, floor);
  const far = Math.max(depth + sphere.radius * 1.01, near * 2);
  return [near, far];
}

export function sphereOf(bbox) {
  if (!bbox) return { center: [0, 0, 0], radius: 1 };
  const center = [0, 1, 2].map((k) => (bbox.min[k] + bbox.max[k]) / 2);
  const radius = Math.hypot(...[0, 1, 2].map((k) => bbox.max[k] - bbox.min[k])) / 2 || 1;
  return { center, radius };
}

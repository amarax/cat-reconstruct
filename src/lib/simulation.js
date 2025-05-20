import * as THREE from 'three';
import satellite from 'satellite.js';

let satrecs = [],
	coverage,
	faces = 0,
	detail = 0,
	running = false;
const dt = 60;
let simT = Date.now() / 1000;
const centroidsCache = {};
function buildC(det) {
	let g = new THREE.IcosahedronGeometry(1, det);
	g = g.toNonIndexed();
	const p = g.attributes.position.array,
		c = [];
	for (let f = 0; f < p.length / 9; f++) {
		const ax = p[9 * f],
			ay = p[9 * f + 1],
			az = p[9 * f + 2],
			bx = p[9 * f + 3],
			by = p[9 * f + 4],
			bz = p[9 * f + 5],
			cx = p[9 * f + 6],
			cy = p[9 * f + 7],
			cz = p[9 * f + 8];
		const mx = (ax + bx + cx) / 3,
			my = (ay + by + cy) / 3,
			mz = (az + bz + cz) / 3,
			l = Math.hypot(mx, my, mz);
		c.push([mx / l, my / l, mz / l]);
	}
	return c;
}
function step() {
	const gst = satellite.gstime(new Date(simT * 1000));
	const cents = centroidsCache[detail];
	satrecs.forEach((s) => {
		const pv = satellite.propagate(s, new Date(simT * 1000));
		if (!pv.position) return;
		const { x, y, z } = satellite.eciToEcf(pv.position, gst);
		const len = Math.hypot(x, y, z);
		const d = [x / len, y / len, z / len];
		cents.forEach((c, i) => {
			if (d[0] * c[0] + d[1] * c[1] + d[2] * c[2] > 0) coverage[i] += 1;
		});
	});
	simT += dt;
}
let timer = null;
function start() {
	if (timer) return;
	timer = setInterval(
		() => {
			for (let i = 0; i < 10; i++) step();
			self.postMessage({ coverage: coverage.buffer, time: simT }, [coverage.buffer]);
			coverage = new Float32Array(coverage);
		},
		dt * 10 * 1000
	);
}
function stop() {
	if (timer) clearInterval(timer);
	timer = null;
}
self.onmessage = (e) => {
	const { cmd, payload } = e.data;
	if (cmd === 'init') {
		detail = payload.detail;
		faces = 20 * 4 ** detail;
		coverage = new Float32Array(faces);
		satrecs = payload.tles.map(([l1, l2]) => satellite.twoline2satrec(l1, l2));
		if (!centroidsCache[detail]) centroidsCache[detail] = buildC(detail);
	}
	if (cmd === 'start') start();
	if (cmd === 'stop') stop();
};

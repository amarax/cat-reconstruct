import * as THREE from 'three';
import satellite from 'satellite.js';

var satrecs = [],
	coverage = null,
	faces = 0,
	detail = 0,
	running = false;
var dt = 60;
var simT = Date.now() / 1000;
var centroidsCache = Object.create(null);
function buildC(det) {
	var g = new THREE.IcosahedronGeometry(1, det);
	g = g.toNonIndexed();
	var p = g.attributes.position.array,
		c = [];
	for (var f = 0; f < p.length / 9; f++) {
		var ax = p[9 * f],
			ay = p[9 * f + 1],
			az = p[9 * f + 2],
			bx = p[9 * f + 3],
			by = p[9 * f + 4],
			bz = p[9 * f + 5],
			cx = p[9 * f + 6],
			cy = p[9 * f + 7],
			cz = p[9 * f + 8];
		var mx = (ax + bx + cx) / 3,
			my = (ay + by + cy) / 3,
			mz = (az + bz + cz) / 3,
			l = Math.hypot(mx, my, mz);
		c.push([mx / l, my / l, mz / l]);
	}
	return c;
}
function step() {
	var gst = satellite.gstime(new Date(simT * 1000));
	var cents = centroidsCache[detail] || [];
	satrecs.forEach(function(s) {
		var pv = satellite.propagate(s, new Date(simT * 1000));
		if (!pv.position) return;
		var ecf = satellite.eciToEcf(pv.position, gst);
		var x = ecf.x, y = ecf.y, z = ecf.z;
		var len = Math.hypot(x, y, z);
		var d = [x / len, y / len, z / len];
		cents.forEach(function(c, i) {
			if (d[0] * c[0] + d[1] * c[1] + d[2] * c[2] > 0) coverage[i] += 1;
		});
	});
	simT += dt;
}
var timer = null;
function start() {
	if (timer) return;
	function tick() {
		for (var i = 0; i < 10; i++) step();
		if (coverage && coverage.buffer) {
			self.postMessage({ coverage: coverage.buffer, time: simT }, [coverage.buffer]); // correct transferable usage
			coverage = new Float32Array(coverage);
		}
		timer = setTimeout(tick, 1000); // 1s real time
	}
	tick();
}
function stop() {
	if (timer) clearTimeout(timer);
	timer = null;
}
self.onmessage = function(e) {
	var cmd = e.data.cmd;
	var payload = e.data.payload;
	if (cmd === 'init') {
		detail = payload.detail;
		faces = 20 * Math.pow(4, detail);
		coverage = new Float32Array(faces);
		satrecs = payload.tles.map(function(tle) { return satellite.twoline2satrec(tle[0], tle[1]); });
		if (!centroidsCache[detail]) centroidsCache[detail] = buildC(detail);
		simT = Date.now() / 1000; // Reset simulation time to now on each init
	}
	if (cmd === 'start') start();
	if (cmd === 'stop') stop();
};

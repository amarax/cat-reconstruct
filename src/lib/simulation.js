// Web Worker for satellite coverage simulation (ESM, for SvelteKit)
// Receives: { cmd: 'init', payload: { detail, tles } }, { cmd: 'start' }, { cmd: 'stop' }
// Posts: { coverage, time }

import * as satellite from 'satellite.js';

/** @type {number} */
let detail = 3;
/** @type {Array<[string, string]>} */
let tles = [];
/** @type {Array<any>} */
let satrecs = [];
let running = false;
/** @type {Float32Array} */
let coverage = new Float32Array(0);
/** @type {Array<number[]>} */
let centroids = [];
/** @type {Array<number[]>} */
let normals = [];
let time = 0;
const step = 1; // seconds per timestep
const maxTime = 86400; // 1 day

/**
 * @param {Array<number[]>} positions
 * @param {Array<number[]>} faces
 * @returns {Array<number[]>}
 */
function computeCentroids(positions, faces) {
    return faces.map(([a,b,c]) => {
        const v1 = positions[a], v2 = positions[b], v3 = positions[c];
        return [
            (v1[0]+v2[0]+v3[0])/3,
            (v1[1]+v2[1]+v3[1])/3,
            (v1[2]+v2[2]+v3[2])/3
        ];
    });
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }

/**
 * @param {number[]} a
 * @returns {number[]}
 */
function norm(a) { const l=Math.hypot(...a); return a.map(x=>x/l); }

/**
 * @param {number[]} pos
 * @param {Array<number[]>} centroids
 * @returns {number}
 */
function findFaceIdx(pos, centroids) {
    let maxDot = -Infinity, idx = -1;
    for (let i=0; i<centroids.length; i++) {
        const d = dot(norm(pos), norm(centroids[i]));
        if (d > maxDot) { maxDot = d; idx = i; }
    }
    return idx;
}

/**
 * @param {Array<any>} satrecs
 * @param {Date} date
 * @returns {Array<(number[]|null)>}
 */
function propagateAllSats(satrecs, date) {
    return satrecs.map(satrec => {
        const pv = satellite.propagate(satrec, date);
        if (!pv || !pv.position) return null;
        return [pv.position.x, pv.position.y, pv.position.z];
    });
}

/**
 * @param {number} n
 */
function resetCoverage(n) {
    coverage = new Float32Array(n);
}

/**
 * @param {{tles: Array<[string, string]>, centroids: Array<number[]>, normals: Array<number[]>, startEpoch?: number}} payload
 */
function handleInit(payload) {
    tles = payload.tles || [];
    centroids = payload.centroids || [];
    normals = payload.normals || [];
    satrecs = tles.map(([tle1, tle2]) => satellite.twoline2satrec(tle1, tle2));
    resetCoverage(centroids.length);
    time = 0;
    if (typeof payload.startEpoch === 'number') {
        startEpoch = payload.startEpoch;
    } else {
        startEpoch = Date.now() / 1000;
    }
}

// Add a global for startEpoch
let startEpoch = Date.now() / 1000;

function handleStart() {
    if (running) return;
    running = true;
    time = 0;
    simLoop();
}

function handleStop() {
    running = false;
}

const coneAngle = 10; // degrees

function simLoop() {
    if (!running) return;
    // Use startEpoch for simulation time
    const date = new Date((startEpoch + time) * 1000);
    const satPositions = propagateAllSats(satrecs, date);
    // For each satellite, check which triangles are covered
    const cosThreshold = Math.cos(coneAngle * Math.PI / 180); // 10 degree cone
    for (const pos of satPositions) {
        if (!pos) continue;
        const satNorm = norm(pos);
        for (let i = 0; i < centroids.length; i++) {
            // Angle between sat->centroid and normal
            const c = centroids[i];
            const n = normals[i];
            // Vector from origin to centroid (should be unit)
            // Vector from origin to satellite (satNorm)
            // If dot(satNorm, n) > cosThreshold, satellite is within cone of normal
            if (dot(satNorm, n) > cosThreshold) {
                coverage[i] += 1;
            }
        }
    }
    time += step;
    self.postMessage({ coverage: Array.from(coverage), time });
    if (time < maxTime) {
        setTimeout(simLoop, 0);
    } else {
        running = false;
    }
}

self.onmessage = function(e) {
    const { cmd, payload } = e.data;
    if (cmd === 'init') handleInit(payload);
    else if (cmd === 'start') handleStart();
    else if (cmd === 'stop') handleStop();
};

export default null; // For SvelteKit ?worker import

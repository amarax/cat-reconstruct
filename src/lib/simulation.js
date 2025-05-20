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
let maxTime = 30 * 86400;
let startTime = 0;

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
 * @param {{tles: Array<[string, string]>, centroids: Array<number[]>, normals: Array<number[]>, startEpoch?: number, simStartTime?: number, simEndTime?: number}} payload
 */
function handleInit(payload) {
    tles = payload.tles || [];
    centroids = payload.centroids || [];
    normals = payload.normals || [];
    satrecs = tles.map(([tle1, tle2]) => satellite.twoline2satrec(tle1, tle2));
    resetCoverage(centroids.length);
    time = 0;
    startTime = payload.simStartTime || 0;
    maxTime = payload.simEndTime || (30 * 86400);
    if (typeof payload.startEpoch === 'number') {
        startEpoch = payload.startEpoch;
    } else {
        startEpoch = Date.now() / 1000;
    }
}

// startEpoch is initialized in handleInit
let startEpoch = 0; // default to epoch 0 until initialized

function handleStart() {
    if (running) return;
    running = true;
    time = 0;
    simLoop();
}

function handleResume() {
    if (running) return;
    running = true;
    simLoop();
}

function handlePause() {
    running = false;
}

function handleStop() {
    running = false;
    time = 0;
    resetCoverage(centroids.length);
}

const coneAngle = 10; // degrees
const loopMaxTime = 1000; // ms

function simLoop() {
    if (!running) return;
    
    if (time < startTime) {
        time = startTime;
    }

    const loopStart = performance.now();

    /** @type {Array<number[] | null>} */
    let satPositions = [];
    while (performance.now() - loopStart < loopMaxTime) {

        // Use startEpoch for simulation time
        const date = new Date((startEpoch + time) * 1000);
        satPositions = propagateAllSats(satrecs, date);
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

    }
    
    // Send positions along with coverage data
    self.postMessage({ 
        coverage: Array.from(coverage), 
        time,
        positions: satPositions.map(pos => pos ? {x: pos[0], y: pos[1], z: pos[2]} : null)
    });
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
    else if (cmd === 'pause') handlePause();
    else if (cmd === 'resume') handleResume();
    else if (cmd === 'stop') handleStop();
};

export default null; // For SvelteKit ?worker import

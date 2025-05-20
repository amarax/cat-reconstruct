// Web Worker for satellite coverage simulation (ESM, for SvelteKit)
// Receives: { cmd: 'init', payload: { detail, tles } }, { cmd: 'start' }, { cmd: 'stop' }
// Posts: { coverage, time, positions }

import * as satellite from 'satellite.js';

/** @type {number} */
let detail = 3;
/** @type {Array<[string, string]>} */
let tles = [];
/** @type {Array<any>} */
let satrecs = [];
let running = false;
/** @type {Uint32Array} */
let coverage = new Uint32Array(0);
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
 * Convert ECI coordinates to ECEF
 * @param {number[]} eci ECI coordinates [x, y, z]
 * @param {number} gmst Greenwich Mean Sidereal Time in radians
 * @returns {number[]} ECEF coordinates [x, y, z]
 */
function eciToEcef(eci, gmst) {
    const rotation = [
        Math.cos(gmst), -Math.sin(gmst), 0,
        Math.sin(gmst), Math.cos(gmst), 0,
        0, 0, 1
    ];
    
    return [
        rotation[0]*eci[0] + rotation[1]*eci[1] + rotation[2]*eci[2],
        rotation[3]*eci[0] + rotation[4]*eci[1] + rotation[5]*eci[2],
        rotation[6]*eci[0] + rotation[7]*eci[1] + rotation[8]*eci[2]
    ];
}

/**
 * @param {Array<any>} satrecs
 * @param {Date} date
 * @returns {Array<(number[]|null)>}
 */
function propagateAllSats(satrecs, date) {
    const gmst = satellite.gstime(date);
    
    return satrecs.map(satrec => {
        const pv = satellite.propagate(satrec, date);
        if (!pv || !pv.position) return null;
        
        // Get position in ECI
        const eci = [pv.position.x, pv.position.y, pv.position.z];
        
        // Convert to ECEF
        return eciToEcef(eci, gmst);
    });
}

/**
 * @param {number} n
 */
function resetCoverage(n) {
    coverage = new Uint32Array(n);
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

const coneAngle = 5; // degrees
const loopMaxTime = 1000; // ms

function simLoop() {
    if (!running) return;
    
    if (time < startTime) {
        time = startTime;
    }

    const loopStart = performance.now();

    /** @type {Array<number[] | null>} */
    let satPositions = [];

    do {
        // Use startEpoch for simulation time
        const date = new Date((startEpoch + time) * 1000);
        satPositions = propagateAllSats(satrecs, date);
        
        // For each satellite, check which triangles are covered
        const cosThreshold = Math.cos(coneAngle * Math.PI / 180);

        satPositions.forEach((pos, satIdx) => {
            if (!pos) return;
            // Get normalized direction from center to satellite (already in ECEF)
            const satDir = norm(pos);
            
            for (let i = 0; i < centroids.length; i++) {
                const n = normals[i];
                
                // First check if satellite can see this face (dot product > 0)
                // Then check if it's within the cone angle
                const cosAngle = dot(satDir, n);
                if (cosAngle > 0 && cosAngle > cosThreshold) {
                    coverage[i] += 1;
                }
            }
        });
        time += step;

    } while (performance.now() - loopStart < loopMaxTime)
    
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

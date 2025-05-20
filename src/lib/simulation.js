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
let faces = [];
let time = 0;
const step = 60; // seconds per timestep
const maxTime = 86400; // 1 day

// Icosahedron generation (Three.js compatible)
/**
 * @param {number} detail
 * @returns {{positions: Array<number[]>, faces: Array<number[]>}}
 */
function createIcosahedron(detail) {
    const t = (1 + Math.sqrt(5)) / 2;
    /** @type {Array<number[]>} */
    let positions = [
        [-1,  t,  0], [ 1,  t,  0], [-1, -t,  0], [ 1, -t,  0],
        [ 0, -1,  t], [ 0,  1,  t], [ 0, -1, -t], [ 0,  1, -t],
        [ t,  0, -1], [ t,  0,  1], [-t,  0, -1], [-t,  0,  1],
    ];
    positions = positions.map(v => {
        const len = Math.hypot(...v);
        return v.map(x => x / len);
    });
    /** @type {Array<number[]>} */
    let faces = [
        [0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],
        [1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
        [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],
        [4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]
    ];
    /** @type {Object.<string, number>} */
    const middleCache = {};
    /**
     * @param {number} a
     * @param {number} b
     * @returns {number}
     */
    function middle(a, b) {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (middleCache[key] !== undefined) return middleCache[key];
        const v1 = positions[a], v2 = positions[b];
        const m = [
            (v1[0]+v2[0])/2,
            (v1[1]+v2[1])/2,
            (v1[2]+v2[2])/2
        ];
        const len = Math.hypot(...m);
        const norm = m.map(x => x/len);
        positions.push(norm);
        middleCache[key] = positions.length-1;
        return middleCache[key];
    }
    for (let d=0; d<detail; d++) {
        /** @type {Array<number[]>} */
        const faces2 = [];
        for (const f of faces) {
            const [a,b,c] = f;
            const ab = middle(a,b);
            const bc = middle(b,c);
            const ca = middle(c,a);
            faces2.push([a,ab,ca],[b,bc,ab],[c,ca,bc],[ab,bc,ca]);
        }
        faces = faces2;
    }
    return { positions, faces };
}

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
 * @param {{detail: number, tles: Array<[string, string]>}} payload
 */
function handleInit(payload) {
    detail = payload.detail || 3;
    tles = payload.tles || [];
    satrecs = tles.map(([tle1, tle2]) => satellite.twoline2satrec(tle1, tle2));
    const mesh = createIcosahedron(detail);
    faces = mesh.faces;
    centroids = computeCentroids(mesh.positions, faces);
    resetCoverage(faces.length);
    time = 0;
}

function handleStart() {
    if (running) return;
    running = true;
    time = 0;
    simLoop();
}

function handleStop() {
    running = false;
}

function simLoop() {
    if (!running) return;
    const date = new Date(Date.now() + time*1000);
    const satPositions = propagateAllSats(satrecs, date);
    for (const pos of satPositions) {
        if (!pos) continue;
        const idx = findFaceIdx(pos, centroids);
        if (idx >= 0) coverage[idx] += 1;
    }
    time += step;
    // Send as plain array for compatibility
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

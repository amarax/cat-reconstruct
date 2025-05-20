<!-- +page.svelte (SvelteKit) – Satellite Coverage Visualiser -->
<script lang="ts">
	import { onMount } from 'svelte';
	import * as THREE from 'three';
	import * as satellite from 'satellite.js';
	import SimulationWorker from '$lib/simulation?worker';
	import CoverageHistogram from '$lib/components/CoverageHistogram.svelte';

	import '../app.css';
	/********************* UI state *************************/
	let detail = 3; // Icosahedron tessellation (2‑20)
	let simSeconds = 0; // Playback 0‑86400 seconds
	const simStartEpoch = Date.now() / 1000; // UNIX seconds at load time
	let selectedIdx: number | null = null; // Currently tracked satellite

	/********************* Satellite master list ***********/
	interface SatRec {
		name: string;
		color: string;
		tle1: string;
		tle2: string;
	}
	const baseSats: SatRec[] = [
		{
			name: 'ISS',
			color: '#ff8c00',
			tle1: '1 25544U 98067A   24124.08267593  .00006238  00000+0  11435-3 0  9994',
			tle2: '2 25544  51.6434  17.1645 0005574  23.5163  72.4238 15.49811848391744'
		},
		{
			name: 'CUBESAT‑1',
			color: '#00d1ff',
			tle1: '1 51025U 22002A   24124.18346310  .00009878  00000+0  53146-3 0  9992',
			tle2: '2 51025  97.6158 167.4367 0001252 157.9119 202.2158 15.16735983 14676'
		},
		{
			name: 'CUBESAT‑2',
			color: '#ff3c7d',
			tle1: '1 44365U 19017C   24124.07791319  .00006430  00000+0  56520-3 0  9992',
			tle2: '2 44365  97.4732  68.5907 0011873 314.5033  45.5469 15.01515154321723'
		}
	];
	let sats: SatRec[] = [...baseSats]; // GNSS fetched onMount and pushed

	function hslToHex(h: number, s = 100, l = 50) {
		l /= 100;
		s /= 100;
		const k = (n: number) => (n + h / 30) % 12;
		const a = s * Math.min(l, 1 - l);
		const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
		const toHex = (x: number) =>
			Math.round(x * 255)
				.toString(16)
				.padStart(2, '0');
		return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
	}

	/********************* Three.js refs *************************/
	let container: HTMLDivElement; // main div for renderer
	let renderer: THREE.WebGLRenderer;
	let scene: THREE.Scene;
	let camera: THREE.PerspectiveCamera;
	let controls: any; // OrbitControls (imported dynamically)

	const EARTH_RADIUS_KM = 6371;
	const cameraDefaultRadius = 3; // initial distance from origin
	let earthGroup: THREE.Group; // Earth + icosahedron + axes
	let satMeshes: THREE.Mesh[] = []; // three.js spheres for sats
	let satRecords: satellite.SatRecord[] = [];
	let icoHeatMesh: THREE.Object3D | null = null; // Heatmap mesh
	let icoWireMesh: THREE.Object3D | null = null; // Wireframe mesh
	let normalLines: THREE.LineSegments | null = null; // Normal vector lines

	// Function to update icosahedron when detail changes
	function updateIcosahedron(detail) {
		if (!earthGroup) return;
		// Remove old meshes if present
		if (icoHeatMesh && earthGroup.children.includes(icoHeatMesh)) {
			earthGroup.remove(icoHeatMesh);
		}
		if (icoWireMesh && earthGroup.children.includes(icoWireMesh)) {
			earthGroup.remove(icoWireMesh);
		}
		if (normalLines && earthGroup.children.includes(normalLines)) {
			earthGroup.remove(normalLines);
		}

		// Create geometry for both meshes
		const geometry = new THREE.IcosahedronGeometry(1.02, detail);
		geometry.rotateX(Math.PI / 2);

		// --- Heatmap mesh ---
		const color = new THREE.Color();
		const colors = [];
		for (let i = 0; i < geometry.attributes.position.count; i++) {
			color.setRGB(1, 1, 1); // default white
			colors.push(color.r, color.g, color.b, 0.0); // default fully transparent
		}
		geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
		const heatMaterial = new THREE.MeshStandardMaterial({
			vertexColors: true,
			transparent: true,
			opacity: 1.0,
			depthWrite: false
		});
		icoHeatMesh = new THREE.Mesh(geometry, heatMaterial);
		earthGroup.add(icoHeatMesh);

		// --- Wireframe mesh ---
		const wireMaterial = new THREE.MeshBasicMaterial({
			color: 0xffffff,
			wireframe: true,
			opacity: 0.7,
			transparent: true
		});
		icoWireMesh = new THREE.Mesh(geometry, wireMaterial);
		earthGroup.add(icoWireMesh);

		// Reset the simulation coverage when detail changes
		simCoverage = null;
	}

	// Reactive statement to update icosahedron when detail changes
	$: updateIcosahedron(detail);

	/***************** Fetch GPS‑OPS TLEs then set up ***********/
	async function fetchGPS() {
		const res = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=gps-ops&FORMAT=tle');
		if (!res.ok) return;
		const txt = await res.text();
		const lines = txt.trim().split(/\n+/);
		const newSats = [...sats]; // Create a new array with existing satellites
		for (let i = 0; i < lines.length - 2; i += 3) {
			const name = lines[i].replace(/^0 /, '').trim();
			const hue = (newSats.length * 137.508) % 360;
			newSats.push({
				name,
				color: hslToHex(hue),
				tle1: lines[i + 1].trim(),
				tle2: lines[i + 2].trim()
			});
		}
		sats = newSats; // Reassign to trigger reactivity
	}
	let poleLines: THREE.LineSegments;

	/*********************** Set up Three scene ****************/
	onMount(async () => {
		// Fetch GNSS constellation first. Try checking localstorage if available.
        // If not, fetch from CelesTrak.
        // if (localStorage.getItem('gpsTLEs')) {
        //     const storedTLEs = JSON.parse(localStorage.getItem('gpsTLEs') || '[]');
        //     sats = [...baseSats, ...storedTLEs];
        // } else {
        //     await fetchGPS();
        //     localStorage.setItem('gpsTLEs', JSON.stringify(sats));
        // }
		

		// Build satRecords array once satellite.js is ready
		satRecords = sats.map(({ tle1, tle2 }) => satellite.twoline2satrec(tle1, tle2));

		// Renderer & camera
		renderer = new THREE.WebGLRenderer({ antialias: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.setSize(container.clientWidth, container.clientHeight);
		container.appendChild(renderer.domElement);

		camera = new THREE.PerspectiveCamera(
			45,
			container.clientWidth / container.clientHeight,
			0.1,
			100
		);
		camera.position.set(0, 0, cameraDefaultRadius);
		camera.up.set(0, 0, 1); // Z = geo‑north

		scene = new THREE.Scene();

		// Controls (OrbitControls imported dynamically to avoid SSR)
		const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
		controls = new OrbitControls(camera, renderer.domElement);
		controls.enablePan = false;
		controls.target.set(0, 0, 0);

		// Earth Sphere (height‑map greyscale texture)
		const earthTex = await new Promise<THREE.Texture>((resolve) => {
			new THREE.TextureLoader().load(
				'/gebco_08_rev_elev_4096x2048.png',
				(tex) => {
					tex.needsUpdate = true;
					resolve(tex);
				},
				undefined,
				() => resolve(null)
			);
		});
		const earthMaterial = earthTex
			? new THREE.MeshStandardMaterial({ map: earthTex, roughness: 1 })
			: new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 1 });
		const earthGeometry = new THREE.SphereGeometry(1, 128, 128);
		earthGeometry.rotateX(Math.PI / 2);
		const earthMesh = new THREE.Mesh(earthGeometry, earthMaterial);

		// Pole axes
		const poleGeom = new THREE.BufferGeometry().setAttribute(
			'position',
			new THREE.Float32BufferAttribute([0, 0, -1.2, 0, 0, -1.7, 0, 0, 1.2, 0, 0, 1.7], 3)
		);
		poleLines = new THREE.LineSegments(poleGeom, new THREE.LineBasicMaterial({ color: 0x00ff00 }));

		earthGroup = new THREE.Group();
		earthGroup.add(earthMesh, poleLines);
		scene.add(earthGroup);

		// Initial icosahedron creation
		updateIcosahedron(detail);

		// Lights
		scene.add(new THREE.AmbientLight(0xffffff, 0.9));

		// Create meshes for satellites
		const satGeom = new THREE.SphereGeometry(0.02, 8, 8);
		sats.forEach(({ color }, idx) => {
			const mesh = new THREE.Mesh(satGeom, new THREE.MeshBasicMaterial({ color }));
			scene.add(mesh);
			satMeshes[idx] = mesh;
		});

		window.addEventListener('resize', () => {
			camera.aspect = container.clientWidth / container.clientHeight;
			camera.updateProjectionMatrix();
			renderer.setSize(container.clientWidth, container.clientHeight);
		});

		animate();
		// Start simulation automatically when visualisation is ready
		//startSim();
	});

	/*********************** Animation loop *************************/
	function animate() {
		requestAnimationFrame(animate);

		// Rotate Earth group inertially
		earthGroup.rotation.z = (simSeconds / 86164) * 2 * Math.PI;

		if (!simRunning) {
			// Update satellite positions
			const date = new Date((simStartEpoch + simSeconds) * 1000);
			satRecords.forEach((satrec, idx) => {
				const posVel = satellite.propagate(satrec, date);
				if (!posVel.position) return;
				const { x, y, z } = posVel.position; // km in ECI
				satMeshes[idx].position.set(x / EARTH_RADIUS_KM, y / EARTH_RADIUS_KM, z / EARTH_RADIUS_KM);
			});
		}

		// Camera tracking – rotate only, respect current zoom
		if (selectedIdx !== null) {
			const satPos = satMeshes[selectedIdx].position.clone();
			const dir = satPos.normalize();
			const radius = camera.position.length();
			camera.position.copy(dir.multiplyScalar(radius));
		}
		camera.lookAt(0, 0, 0);

		controls.update();
		renderer.render(scene, camera);
	}

	/******************** Helpers for UI bindings ***************************/
	function toggleSat(idx: number) {
		selectedIdx = selectedIdx === idx ? null : idx;
		if (selectedIdx !== null) {
			// initial radius set 20% beyond sat distance
			const satDist = satMeshes[selectedIdx].position.length();
			camera.position.copy(
				satMeshes[selectedIdx].position
					.clone()
					.normalize()
					.multiplyScalar(satDist * 1.2)
			);
		}
	}

	let simWorker: Worker | null = null;
	let simRunning = false;
	let simCoverage: Float32Array | null = null;
	let simTime = 0;

	function getIcosahedronCentroidsAndNormals(geometry: THREE.IcosahedronGeometry) {
		const posAttr = geometry.getAttribute('position');
		const indexAttr = geometry.getIndex();
		const centroids: number[][] = [];
		const normals: number[][] = [];
		if (indexAttr) {
			for (let i = 0; i < indexAttr.count; i += 3) {
				const a = indexAttr.getX(i);
				const b = indexAttr.getX(i + 1);
				const c = indexAttr.getX(i + 2);
				const vA = [posAttr.getX(a), posAttr.getY(a), posAttr.getZ(a)];
				const vB = [posAttr.getX(b), posAttr.getY(b), posAttr.getZ(b)];
				const vC = [posAttr.getX(c), posAttr.getY(c), posAttr.getZ(c)];
				const centroid = [
					(vA[0] + vB[0] + vC[0]) / 3,
					(vA[1] + vB[1] + vC[1]) / 3,
					(vA[2] + vB[2] + vC[2]) / 3
				];
				// Calculate edge vectors
				const ab = [vB[0] - vA[0], vB[1] - vA[1], vB[2] - vA[2]];
				const ac = [vC[0] - vA[0], vC[1] - vA[1], vC[2] - vA[2]];
				// Cross product for normal vector (right-hand rule)
				const normal = [
					ab[1] * ac[2] - ab[2] * ac[1], // i component
					ab[2] * ac[0] - ab[0] * ac[2], // j component
					ab[0] * ac[1] - ab[1] * ac[0] // k component
				];
				const len = Math.hypot(...normal);
				normals.push([normal[0] / len, normal[1] / len, normal[2] / len]);
				centroids.push(centroid);
			}
		} else {
			// Non-indexed geometry: every 3 consecutive vertices is a face
			for (let i = 0; i < posAttr.count; i += 3) {
				const vA = [posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)];
				const vB = [posAttr.getX(i + 1), posAttr.getY(i + 1), posAttr.getZ(i + 1)];
				const vC = [posAttr.getX(i + 2), posAttr.getY(i + 2), posAttr.getZ(i + 2)];
				const centroid = [
					(vA[0] + vB[0] + vC[0]) / 3,
					(vA[1] + vB[1] + vC[1]) / 3,
					(vA[2] + vB[2] + vC[2]) / 3
				];
				const ab = [vB[0] - vA[0], vB[1] - vA[1], vB[2] - vA[2]];
				const ac = [vC[0] - vA[0], vC[1] - vA[1], vC[2] - vA[2]]; // Fixed z-coordinate index
				const normal = [
					ab[1] * ac[2] - ab[2] * ac[1],
					ab[2] * ac[0] - ab[0] * ac[2],
					ab[0] * ac[1] - ab[1] * ac[0]
				];
				const len = Math.hypot(...normal);
				normals.push([normal[0] / len, normal[1] / len, normal[2] / len]);
				centroids.push(centroid);
			}
		}
		return { centroids, normals };
	}

	function startSim() {
		if (simWorker) return;
		simWorker = new SimulationWorker();
		simWorker.onmessage = (e) => {
			const { coverage, time, positions } = e.data;
			if (coverage) {
				// Accept both Array and ArrayBuffer (for future-proofing)
				if (Array.isArray(coverage)) {
					simCoverage = new Float32Array(coverage);
				} else if (coverage instanceof Float32Array) {
					simCoverage = coverage;
				} else if (coverage instanceof ArrayBuffer) {
					simCoverage = new Float32Array(coverage);
				}
			}
			if (typeof time === 'number') {
				simTime = time;
				simSeconds = time; // Sync visualisation time to simulation
			}
			if (positions) {
				// Update satellite positions from simulation
				positions.forEach((pos, idx) => {
					if (!pos) return;
					satMeshes[idx].position.set(
						pos.x / EARTH_RADIUS_KM,
						pos.y / EARTH_RADIUS_KM,
						pos.z / EARTH_RADIUS_KM
					);
				});
			}
		};
		// Prepare centroids and normals from the current geometry
		const geometry = (icoHeatMesh as THREE.Mesh).geometry as THREE.IcosahedronGeometry;
		const { centroids, normals } = getIcosahedronCentroidsAndNormals(geometry);
		simWorker.postMessage({
			cmd: 'init',
			payload: {
				tles: sats.map((s) => [s.tle1, s.tle2]),
				centroids,
				normals,
				startEpoch: simStartEpoch // Pass the start time to the worker
			}
		});
		simWorker.postMessage({ cmd: 'start' });
		simRunning = true;
	}

	function stopSim() {
		if (!simWorker) return;
		simWorker.postMessage({ cmd: 'stop' });
		simWorker.terminate();
		simWorker = null;
		simRunning = false;
		// Don't clear simCoverage to preserve the heatmap visualization
	}

	$: if (simCoverage && icoHeatMesh) {
		// Color faces by coverage (simple heatmap: blue=low, red=high, alpha=0 if not visited)
		const geometry = (icoHeatMesh as THREE.Mesh).geometry;
		const colors = geometry.attributes.color.array;
		const max = Math.max(...simCoverage);
		for (let f = 0; f < simCoverage.length; f++) {
			const vIdx = f * 12; // 3 vertices per face, 4 values per vertex
			const cov = simCoverage[f];
			const t = max > 0 ? cov / max : 0;
			// Heatmap: blue (low) to red (high)
			const r = t,
				g = 0,
				b = 1 - t;
			const a = cov > 0 ? 0.7 : 0.0;
			for (let i = 0; i < 3; i++) {
				colors[vIdx + i * 4 + 0] = r;
				colors[vIdx + i * 4 + 1] = g;
				colors[vIdx + i * 4 + 2] = b;
				colors[vIdx + i * 4 + 3] = a;
			}
		}
		geometry.attributes.color.needsUpdate = true;
	}
</script>

<div bind:this={container} class="relative h-screen w-full">
	<!-- Tessellation + Playback Controls -->
	<div class="overlay top-4 left-4">
		<label>Tessellation: {detail}</label>
		<input type="range" min="2" max="20" bind:value={detail} step="1" />
	</div>

	<div class="overlay bottom-4 left-1/2 w-3/4 -translate-x-1/2 text-center">
		<input type="range" min="0" max="86400" step="60" bind:value={simSeconds} class="w-full" />
		<div class="mt-1 font-mono">{new Date((simStartEpoch + simSeconds) * 1000).toUTCString()}</div>
	</div>

	<!-- Satellite list -->
	<div class="overlay top-20 left-4 max-h-[60vh] overflow-y-auto">
		{#each sats as sat, idx}
			<div
				on:click={() => toggleSat(idx)}
				class="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 {selectedIdx === idx
					? 'bg-gray-200'
					: ''}"
			>
				<span class="inline-block h-3 w-3 rounded-full" style="background:{sat.color}"></span>
				<span>{sat.name}</span>
			</div>
		{/each}
	</div>

	<!-- Simulation controls -->
	<div class="overlay top-4 right-4 flex w-100 flex-col gap-2">
		<button
			on:click={simRunning ? stopSim : startSim}
			class="rounded bg-blue-500 px-2 py-1 text-white"
		>
			{simRunning ? 'Stop Simulation' : 'Start Simulation'}
		</button>
		{#if simRunning}
			<div class="text-xs">
				Sim time: {new Date((simStartEpoch + simSeconds) * 1000).toUTCString()}
			</div>
		{/if}
		{#if simCoverage}
			<div class="text-xs">Coverage bins: {simCoverage.length}</div>
		{/if}
		<CoverageHistogram {simCoverage} />
	</div>
</div>

<style lang="postcss">
	@reference "tailwindcss";
	.overlay {
		@apply absolute z-10 rounded bg-white/80 p-2 text-xs shadow backdrop-blur;
	}
</style>

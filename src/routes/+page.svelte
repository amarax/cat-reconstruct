<!-- +page.svelte (SvelteKit) – Satellite Coverage Visualiser -->
<script lang="ts">
	import { onMount } from 'svelte';
	import * as THREE from 'three';
	import * as satellite from 'satellite.js';
	import SimulationWorker from '$lib/simulation?worker';

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
	const sats: SatRec[] = [...baseSats]; // GNSS fetched onMount and pushed

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

	/***************** Fetch GPS‑OPS TLEs then set up ***********/
	async function fetchGPS() {
		const res = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=gps-ops&FORMAT=tle');
		if (!res.ok) return;
		const txt = await res.text();
		const lines = txt.trim().split(/\n+/);
		for (let i = 0; i < lines.length - 2; i += 3) {
			const name = lines[i].replace(/^0 /, '').trim();
			const hue = (sats.length * 137.508) % 360;
			sats.push({
				name,
				color: hslToHex(hue),
				tle1: lines[i + 1].trim(),
				tle2: lines[i + 2].trim()
			});
		}
	}

	$: icoEdges = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.02, detail));

	/*********************** Set up Three scene ****************/
	onMount(async () => {
		// Fetch GNSS constellation first
		await fetchGPS();

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
				'/gebco_08_rev_elev_21600x10800.png',
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

		// Icosahedron outline
		const icoLine = new THREE.LineSegments(
			icoEdges,
			new THREE.LineBasicMaterial({ color: 0xffffff })
		);

		// Pole axes
		const poleGeom = new THREE.BufferGeometry().setAttribute(
			'position',
			new THREE.Float32BufferAttribute([0, 0, -1.2, 0, 0, -1.7, 0, 0, 1.2, 0, 0, 1.7], 3)
		);
		const poleLines = new THREE.LineSegments(
			poleGeom,
			new THREE.LineBasicMaterial({ color: 0x00ff00 })
		);

		earthGroup = new THREE.Group();
		earthGroup.add(earthMesh, icoLine, poleLines);
		scene.add(earthGroup);

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
	});

	/*********************** Animation loop *************************/
	function animate() {
		requestAnimationFrame(animate);

		// Rotate Earth group inertially
		earthGroup.rotation.y = (simSeconds / 86164) * 2 * Math.PI;

		// Update satellite positions
		const date = new Date((simStartEpoch + simSeconds) * 1000);
		satRecords.forEach((satrec, idx) => {
			const posVel = satellite.propagate(satrec, date);
			if (!posVel.position) return;
			const { x, y, z } = posVel.position; // km in ECI
			satMeshes[idx].position.set(x / EARTH_RADIUS_KM, y / EARTH_RADIUS_KM, z / EARTH_RADIUS_KM);
		});

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
</div>

<style lang="postcss">
	@reference "tailwindcss";
	.overlay {
		@apply absolute z-10 rounded bg-white/80 p-2 text-xs shadow backdrop-blur;
	}
</style>

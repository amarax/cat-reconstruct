<!--
  SatelliteCoverageVisualizer.svelte  –  May 2025
  ---------------------------------------------------------------------------
  Fully self-contained Svelte port of the previous React/Three.js visualiser.
  Key features retained:
    • 3-D Earth sphere (greyscale height texture) + tessellated icosahedron
      mesh coloured by CubeSat-coverage counts streamed from a Web Worker.
    • ISS + CubeSats + GPS constellation rendered as tiny spheres.
    • Worker can be started / stopped with the ▶ / ⏸ button.
    • Camera orbits Earth’s centre; clicking a satellite in the list toggles
      tracking that satellite (camera stays on radial line; radius set once).
    • North stays “up” via camera.up = +Z; green pole markers show poles.
    • Tessellation detail slider 2 – 20.
-->
<script>
	import { onMount, onDestroy } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	
    import SimulationWorker from '$lib/simulation?worker';

	import '../app.css';

	/* ────────── Helper – HSL → HEX ─────────────────────────────────────── */
	const hslToHex = (h, s = 100, l = 50) => {
		l /= 100;
		s /= 100;
		const k = (n) => (n + h / 30) % 12;
		const a = s * Math.min(l, 1 - l);
		const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
		const toHex = (x) =>
			Math.round(x * 255)
				.toString(16)
				.padStart(2, '0');
		return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
	};

	/* ────────── Component state ────────────────────────────────────────── */
	let detail = 3;
	let running = false;
	let visTime = 0; // seconds since epoch (from worker)
	let coverage = null; // Float32Array from worker
	let selectedIdx = null; // current tracked satellite index

	let canvasEl;
	let renderer, scene, camera, controls;
	let earthGroup, coverageMesh, poleLines;
	let satMeshes = [];
	let worker;

	const cameraInitRadius = 3;

	/* ────────── Satellite master list (ISS + CubeSats) ─────────────────── */
	const baseSats = [
		{
			name: 'ISS',
			color: '#ff8c00',
			tle1: '1 25544U 98067A   24124.08267593  .00006238  00000+0  11435-3 0  9994',
			tle2: '2 25544  51.6434  17.1645 0005574  23.5163  72.4238 15.49811848391744'
		},
		{
			name: 'CUBESAT-1',
			color: '#00d1ff',
			tle1: '1 51025U 22002A   24124.18346310  .00009878  00000+0  53146-3 0  9992',
			tle2: '2 51025  97.6158 167.4367 0001252 157.9119 202.2158 15.16735983 14676'
		},
		{
			name: 'CUBESAT-2',
			color: '#ff3c7d',
			tle1: '1 44365U 19017C   24124.07791319  .00006430  00000+0  56520-3 0  9992',
			tle2: '2 44365  97.4732  68.5907 0011873 314.5033  45.5469 15.01515154321723'
		}
	];

	/* ────────── Reactive vars populated at run-time ─────────────────────── */
	let gnssSats = [];
	$: sats = [...baseSats, ...gnssSats];
	$: cubeSatTles = sats
		.filter((s) => s.name.startsWith('CUBESAT'))
		.map(({ tle1, tle2 }) => [tle1, tle2]);

	/* ────────── Fetch GNSS constellation once ───────────────────────────── */
	onMount(async () => {
		const txt = await fetch(
			'https://celestrak.org/NORAD/elements/gp.php?GROUP=gps-ops&FORMAT=tle'
		).then((r) => r.ok && r.text());
		if (txt) {
			const lines = txt.trim().split(/\n+/);
			gnssSats = lines.reduce((arr, line, idx) => {
				if (idx % 3 === 0) {
					const hue = (arr.length * 137.5) % 360;
					arr.push({
						name: line.replace(/^0 /, '').trim(),
						color: hslToHex(hue),
						tle1: lines[idx + 1],
						tle2: lines[idx + 2]
					});
				}
				return arr;
			}, []);
		}
	});

	/* ────────── Init Three.js scene ─────────────────────────────────────── */
	onMount(() => {
		renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.setSize(canvasEl.clientWidth, canvasEl.clientHeight);

		scene = new THREE.Scene();

		camera = new THREE.PerspectiveCamera(
			45,
			canvasEl.clientWidth / canvasEl.clientHeight,
			0.1,
			100
		);
		camera.up.set(0, 0, 1);
		camera.position.set(0, 0, cameraInitRadius);

		controls = new OrbitControls(camera, renderer.domElement);
		controls.enablePan = false;
		controls.target.set(0, 0, 0);

		/* Lights */
		scene.add(new THREE.AmbientLight(0xffffff, 0.9));
		const pl = new THREE.PointLight(0xffffff, 1);
		pl.position.set(10, 10, 10);
		scene.add(pl);

		/* Earth system group */
		earthGroup = new THREE.Group();
		scene.add(earthGroup);

		buildEarthSphere();
		buildPoleLines();
		buildCoverageMesh();

		buildSatMeshes();

		/* Render loop */
		renderer.setAnimationLoop(tick);

		/* Handle resize */
		const onResize = () => {
			renderer.setSize(canvasEl.clientWidth, canvasEl.clientHeight);
			camera.aspect = canvasEl.clientWidth / canvasEl.clientHeight;
			camera.updateProjectionMatrix();
		};
		window.addEventListener('resize', onResize);

		onDestroy(() => {
			window.removeEventListener('resize', onResize);
			renderer.setAnimationLoop(null);
			if (worker) worker.terminate();
		});
	});

	function tick() {
		// inertial rotation
		earthGroup.rotation.y = (visTime / 86164) * Math.PI * 2;

		// update sat mesh positions
		updateSatellitePositions();

		// colour coverage mesh if data available
		if (coverage) updateCoverageColors();

		// camera tracking
		updateCamera();

		controls.update();
		renderer.render(scene, camera);
	}

	/* ────────── Build sub-objects ───────────────────────────────────────── */
	let earthMaterial;
	function buildEarthSphere() {
		const sphere = new THREE.Mesh(
			new THREE.SphereGeometry(1, 128, 128),
			new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 1 })
		);
		earthGroup.add(sphere);

		// load texture async
		fetch('/gebco_08_rev_elev_21600x10800.png')
			.then((r) => r.blob())
			.then(createImageBitmap)
			.then((img) => {
				const c = document.createElement('canvas');
				const w = 2048,
					h = Math.round((img.height / img.width) * w);
				c.width = w;
				c.height = h;
				c.getContext('2d').drawImage(img, 0, 0, w, h);
				const tex = new THREE.CanvasTexture(c);
				sphere.material.map = tex;
				sphere.material.needsUpdate = true;
			});
		earthMaterial = sphere.material;
	}

	function buildPoleLines() {
		const verts = new Float32Array([0, 0, -1.2, 0, 0, -1.7, 0, 0, 1.2, 0, 0, 1.7]);
		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
		const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x00ff00 }));
		poleLines = line;
		earthGroup.add(line);
	}

	function buildCoverageMesh() {
		const geom = new THREE.IcosahedronGeometry(1, detail);
		coverageMesh = new THREE.Mesh(
			geom,
			new THREE.MeshStandardMaterial({
				vertexColors: true,
				opacity: 0.8,
				transparent: true,
				flatShading: true
			})
		);
		coverageMesh.scale.set(1.02, 1.02, 1.02);
		earthGroup?.add(coverageMesh);
	}

	function rebuildCoverageMesh() {
		earthGroup?.remove(coverageMesh);
		buildCoverageMesh();
	}

	function buildSatMeshes() {
		satMeshes.forEach((m) => scene.remove(m));
		satMeshes = sats.map((s) => {
			const mesh = new THREE.Mesh(
				new THREE.SphereGeometry(0.02, 8, 8),
				new THREE.MeshBasicMaterial({ color: new THREE.Color(s.color) })
			);
			scene.add(mesh);
			return mesh;
		});
	}

	/* ────────── Satellite propagation (client-side rendering) ───────────── */
	let satlib;
	let satrecs = [];
	onMount(async () => {
		satlib = (await import('satellite.js')).default || (await import('satellite.js'));
		satrecs = sats.map(({ tle1, tle2 }) => satlib.twoline2satrec(tle1, tle2));
	});

	function updateSatellitePositions() {
		if (!satlib) return;
		const date = new Date(visTime * 1000);
		satrecs.forEach((rec, i) => {
			const pv = satlib.propagate(rec, date);
			const pos = pv?.position;
			const mesh = satMeshes[i];
			if (pos && mesh) mesh.position.set(pos.x / 6371, pos.y / 6371, pos.z / 6371);
		});
	}

	/* ────────── Camera tracking ─────────────────────────────────────────── */
	let firstTrackFrame = true;
	function updateCamera() {
		if (selectedIdx !== null && satMeshes[selectedIdx]) {
			const dir = satMeshes[selectedIdx].position.clone().normalize();
			if (firstTrackFrame) {
				camera.position.copy(dir.multiplyScalar(satMeshes[selectedIdx].position.length() * 1.2));
				firstTrackFrame = false;
			} else {
				const r = camera.position.length();
				camera.position.copy(dir.multiplyScalar(r));
			}
		} else firstTrackFrame = true;
		camera.lookAt(0, 0, 0);
	}

	/* ────────── Coverage colour update ──────────────────────────────────── */
	function updateCoverageColors() {
		const faces = 20 * 4 ** detail;
		if (coverage.length !== faces) return;
		const geom = coverageMesh.geometry;
		const max = Math.max(...coverage) || 1;
		const cols = new Float32Array(faces * 9);
		for (let f = 0; f < faces; f++) {
			const t = coverage[f] / max;
			const r = t,
				g = 0.2,
				b = 1 - t;
			for (let v = 0; v < 3; v++) {
				const idx = f * 9 + v * 3;
				cols[idx] = r;
				cols[idx + 1] = g;
				cols[idx + 2] = b;
			}
		}
		geom.setAttribute('color', new THREE.BufferAttribute(cols, 3));
		geom.attributes.color.needsUpdate = true;
	}

	/* ────────── Web-Worker setup & messaging ────────────────────────────── */
	function spawnWorker() {
		if (worker) worker.terminate();

		worker = new SimulationWorker();
		worker.postMessage({ cmd: 'init', payload: { detail, tles: cubeSatTles } });
		worker.onmessage = (e) => {
			const { coverage: buf, time } = e.data;
			if (buf) coverage = new Float32Array(buf);
			if (time) visTime = time;
		};
	}

    /* spawn worker whenever detail or cubeSatTles change, but only after mount */
    let mounted = false;
    onMount(() => {
        mounted = true;
    });
    $: if (mounted === true) spawnWorker(), [detail, cubeSatTles];

	function toggleRun() {
		if (!worker) return;
		running = !running;
		worker.postMessage({ cmd: running ? 'start' : 'stop' });
	}

	/* ────────── UI interaction helpers ─────────────────────────────────── */
	function selectSat(idx) {
		selectedIdx = selectedIdx === idx ? null : idx;
	}

	$: if (detail !== 0) {
		rebuildCoverageMesh();
		// notify worker of new detail
		if (worker) {
			worker.terminate();
			spawnWorker();
		}
	}
</script>

<div class="relative h-full w-full">
	<canvas bind:this={canvasEl} class="h-full w-full"></canvas>

	<!-- Satellite list -->
	<div class="overlay-panel top-20 left-4 max-h-[60vh] overflow-y-auto">
		{#each sats as sat, i}
			<div
				class="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 {selectedIdx === i
					? 'bg-gray-200'
					: ''}"
				on:click={() => selectSat(i)}
			>
				<span class="inline-block h-3 w-3 rounded-full" style="background:{sat.color}"></span>
				<span>{sat.name}</span>
			</div>
		{/each}
	</div>

	<!-- Controls bottom-right -->
	<div class="absolute right-4 bottom-4 flex flex-col items-end gap-2">
		<button class="rounded bg-blue-600 px-3 py-1 text-white" on:click={toggleRun}
			>{running ? '⏸ Stop' : '▶ Start'}</button
		>
		<div class="overlay-panel font-mono">{new Date(visTime * 1000).toUTCString()}</div>
		<input
			type="range"
			min="2"
			max="20"
			value={detail}
			on:input={(e) => (detail = +e.target.value)}
		/>
	</div>
</div>

<style lang="postcss">
	@reference "tailwindcss";
	.overlay-panel {
		@apply absolute rounded bg-white/80 p-2 text-xs shadow;
	}
	button {
		transition: background 0.2s;
	}
	button:hover {
		background: #2563eb;
	}
</style>

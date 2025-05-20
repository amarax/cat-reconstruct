<!-- CoverageHistogram.svelte -->
<script lang="ts">
	export let coverage: Float32Array | null = null;
	
	// Compute histogram data when coverage changes
	$: histogramData = coverage ? computeHistogram(coverage) : [];
	
	$: console.log(coverage);

	function computeHistogram(coverage: Float32Array) {
		if (!coverage || coverage.length === 0) return [];
		
		// Find the maximum count to determine the number of bins
		const maxCount = Math.max(...coverage);
		const numBins = Math.min(20, Math.ceil(maxCount)); // Cap at 20 bins
		const bins = new Array(numBins).fill(0);
		
		// Populate bins
		for (let i = 0; i < coverage.length; i++) {
			if (coverage[i] === 0) continue; // Skip uncovered areas
			const binIdx = Math.min(
				Math.floor(coverage[i] / (maxCount / numBins)),
				numBins - 1
			);
			bins[binIdx]++;
		}
		
		// Calculate percentages and bin ranges
		const totalCovered = bins.reduce((a, b) => a + b, 0);
		return bins.map((count, i) => ({
			count,
			percentage: totalCovered ? (count / totalCovered) * 100 : 0,
			start: (i * maxCount) / numBins,
			end: ((i + 1) * maxCount) / numBins
		}));
	}
</script>

<div class="w-full p-2">
	<div class="flex h-32 items-end gap-0.5">
		{#if coverage && histogramData.length > 0}
			{#each histogramData as { percentage }, i}
				<div
					class="flex-1 bg-blue-500 transition-all duration-200"
					style="height: {Math.max(1, percentage)}%;"
					title="Coverage count: {Math.round(histogramData[i].start)}-{Math.round(histogramData[i].end)}, Frequency: {histogramData[i].count} cells ({percentage.toFixed(1)}%)"
				></div>
			{/each}
		{:else}
			<!-- Empty histogram bars for visual placeholder -->
			{#each Array(20) as _}
				<div class="flex-1 border border-gray-200"></div>
			{/each}
		{/if}
	</div>
	<div class="mt-1 flex justify-between text-[10px] text-gray-600">
		<span>0</span>
		<span>Visits per cell</span>
		<span>{coverage ? Math.round(Math.max(...coverage)) : '-'}</span>
	</div>
</div>

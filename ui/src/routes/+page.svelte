<script>
  let jobId = '';
  let loading = false;
  let result = null;
  let error = '';

  async function checkStatus() {
    if (!jobId) {
      error = 'Please enter a jobId';
      result = null;
      return;
    }
    loading = true;
    error = '';
    result = null;
    try {
      const res = await fetch(`https://itinerary-generator-production.ai-powered.workers.dev/?jobId=${jobId}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Request failed');
      }
      result = await res.json();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
</script>

<h1>Check Your Itinerary</h1>

<input
  placeholder="Enter jobId"
  bind:value={jobId}
  on:keydown={(e) => e.key === 'Enter' && checkStatus()}
/>
<button on:click={checkStatus} disabled={loading}>Check</button>

{#if loading}
  <p>Loading...</p>
{:else if error}
  <p style="color:red">{error}</p>
{:else if result}
  <h2>Status: {result.status}</h2>
  {#if result.status === 'completed'}
    <h3>Destination: {result.destination}</h3>
    <h4>Days: {result.durationDays}</h4>
    <ul>
      {#each result.itinerary as day}
        <li>
          <strong>Day {day.day}: {day.theme}</strong>
          <ul>
            {#each day.activities as act}
              <li>{act.time}: {act.description} ({act.location})</li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {/if}
{/if}

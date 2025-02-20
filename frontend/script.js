async function handleFormSubmit(event) {
    event.preventDefault();

    const dgsUsername = document.getElementById('dgsUsername').value;
    const bandcampUsername = document.getElementById('bandcampUsername').value;
    const submitButton = event.target.querySelector('button[type="submit"]');
    const progressDiv = document.getElementById('progress');
    const progressBar = document.getElementById('progressBar');

    submitButton.disabled = true;
    progressDiv.innerText = 'Starting';
    progressBar.style.display = 'block';
    progressBar.value = 0;

    const eventSource = new EventSource(`/progress`);

    eventSource.onmessage = function(event) {
        const message = event.data.replace(/^"|"$/g, '');
        progressDiv.innerText = message;

        const percentageMatch = message.match(/Progress: (\d+)%/);
        const etaMatch = message.match(/ETA: (\d+)s/);

        if (percentageMatch) {
            progressBar.value = parseInt(percentageMatch[1], 10);
        }

        if (etaMatch) {
            const eta = parseInt(etaMatch[1], 10);
            progressDiv.innerText += ` | Estimated time remaining: ${eta} seconds`;
        }
    };

    try {
        const response = await fetch(`/fetch-listings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ dgs_username: dgsUsername, bandcamp_username: bandcampUsername })
        });

        const { results, discogsSuccess, bandcampSuccess } = await response.json();
        displayResults(results, discogsSuccess, bandcampSuccess);

        progressDiv.innerText = '';
        progressBar.style.display = 'none';
    } catch (error) {
        console.error('Error fetching listings:', error);
        document.getElementById('results').innerText = 'Error fetching listings. Please try again later.';
        progressDiv.innerText = 'Error occurred! Please try again later.';
    } finally {
        submitButton.disabled = false;
        eventSource.close();
    }
}

function displayResults(listings, discogsSuccess, bandcampSuccess) {
    const resultsDiv = document.getElementById('results');
    resultsDiv.innerHTML = '';

    if (!discogsSuccess) {
        resultsDiv.innerHTML += '<p>Discogs is not responding. Showing Bandcamp results only.</p>';
    }

    if (!bandcampSuccess) {
        resultsDiv.innerHTML += '<p>Bandcamp is not responding. Showing Discogs results only.</p>';
    }

    if (listings.length === 0) {
        resultsDiv.innerText += 'No listings found.';
        return;
    }

    listings.forEach((listing, index) => {
        const listingDiv = document.createElement('div');
        listingDiv.className = 'result-card';
        listingDiv.innerHTML = `
            <h3>${index + 1}. ${listing.name}</h3>
            <img src="${listing.image}" alt="${listing.name}" class="album-image">
            <p>Price: $${listing.price.toFixed(2)}</p>
            <p>Condition: ${listing.condition}</p>
            <a href="${listing.link}" target="_blank">View Listing</a>
        `;
        resultsDiv.appendChild(listingDiv);
    });
}

document.getElementById('userForm').addEventListener('submit', handleFormSubmit);

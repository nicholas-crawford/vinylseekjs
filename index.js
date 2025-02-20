#!/usr/bin/env node

import { config } from 'dotenv';
import { resolve } from 'path';
import * as cheerio from 'cheerio';
import chalk from 'chalk';
import cliProgress from 'cli-progress';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import express from 'express';
import SSE from 'express-sse';
import compression from 'compression';
import rateLimit from 'express-rate-limit';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express()
const port = 8080


config({ path: resolve(__dirname, '.env') });

let releaseIDs = []
let marketplaceIDs = []
let listingData = []
let wantList = null
let filteredListings = []
let uniqueListings = []

const timer = ms => new Promise(res => setTimeout(res, ms))

const sse = new SSE();

app.use(compression());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100,
    message: 'Too many requests from this IP, please try again later.'
});

app.use(limiter);

function checkForEnvironmentVariables() {
    if (process.env.DGS_USERNAME && process.env.TIMER_LIMIT) {
        return true
    }
    console.log("You are missing environment variables. Check the readme for more info.")
    return false
}

async function fetchWantlist(dgsUsername) {
    console.log(chalk.blue('Fetching wantlist'));
    await fetch(`https://api.discogs.com/users/${dgsUsername}/wants`).then(response => {
        return response.json();
    }).then(data => {
        wantList = data.wants;
        sse.send('Progress: 20% | Fetched wantlist');
    })
    .catch(error => {
        console.error('Error fetching want list:', error);
    });
}

function collectReleaseIDs() {
    console.log(chalk.blue('Collecting release IDs'));
    for (let i = 0; i < wantList.length; i++) {
        releaseIDs.push(wantList[i].id);
    }
    sse.send('Progress: 40% | Collected release IDs');
}

async function collectMarketplaceIDs() {
    console.log(chalk.blue('Collecting marketplace IDs'));
    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(releaseIDs.length, 0);

    for (let i = 0; i < releaseIDs.length; i++) {
        await fetch(`https://www.discogs.com/sell/release/${releaseIDs[i]}`).then(response => {
            return response.text();
        }).then(html => {
            const $ = cheerio.load(html);
            $('.shortcut_navigable:not(.unavailable)').each((index, element) => {
                let link = $(element).find('a.item_description_title');
                let linkID = $(link).attr('href');
                let id = linkID.replace(/^\D+/g, '');
                marketplaceIDs.push(id);
            });
        })
        .catch(error => {
            console.error('Error fetching marketplace ids:', error);
        });
        progressBar.update(i + 1);

        const percentage = Math.round(((i + 1) / releaseIDs.length) * 20) + 40;
        sse.send(`Progress: ${percentage}% | Collecting marketplace IDs: ${i + 1}/${releaseIDs.length}`);
    }
    progressBar.stop();
}

async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return response;
        } catch (error) {
            console.error(`Attempt ${attempt + 1} failed: ${error.message}`);
            if (attempt < retries - 1) {
                console.log(`Retrying in ${delay}ms...`);
                await new Promise(res => setTimeout(res, delay));
            } else {
                throw error;
            }
        }
    }
}

async function fetchMarketplaceListingData() {
    console.log(chalk.blue('Fetching marketplace listing data'));

    let totalRequestsMade = 0;
    const maxBatchSize = 60; 

    for (let i = 0; i < marketplaceIDs.length; ) {
        const response = await fetchWithRetry(`https://api.discogs.com/marketplace/listings/${marketplaceIDs[i]}?curr_abbr=AUD`);
        const headers = response.headers;
        const rateLimit = parseInt(headers.get('X-Discogs-Ratelimit'), 10);
        const rateLimitUsed = parseInt(headers.get('X-Discogs-Ratelimit-Used'), 10);
        const rateLimitRemaining = parseInt(headers.get('X-Discogs-Ratelimit-Remaining'), 10);

        const batchSize = Math.min(rateLimitRemaining, maxBatchSize);

        const batch = marketplaceIDs.slice(i, i + batchSize).map(id =>
            fetchWithRetry(`https://api.discogs.com/marketplace/listings/${id}?curr_abbr=AUD`)
                .then(response => response.json())
                .then(data => {
                    if (data?.message !== "You are making requests too quickly.") {
                        listingData.push({
                            name: data.release.description,
                            price: data.price.value,
                            condition: data.condition,
                            sleeve_condition: data.sleeve_condition,
                            link: data.uri,
                            image: data.release.images[0]?.uri
                        });
                    }
                })
                .catch(error => {
                    console.error('Error listing data:', error);
                })
        );

        await Promise.all(batch);

        totalRequestsMade += batchSize;
        i += batchSize;

        console.log(`Processed ${i}/${marketplaceIDs.length} listings. Total requests made: ${totalRequestsMade}`);

        if (i < marketplaceIDs.length) {
            console.log('Waiting for 61 seconds to respect rate limit');
            await timer(61000);
        }
    }

    console.log('Completed fetching marketplace listing data');
}

function removeDuplicates() {
    console.log(chalk.blue('Removing Duplicate Listings'));
    uniqueListings = listingData.reduce((accumulator, current) => {
        const existingItem = accumulator.find(item => item.name === current.name);
        if (existingItem) {
            if (current.price < existingItem.price) {
                const index = accumulator.indexOf(existingItem);
                accumulator[index] = current;
            }
        } else {
            accumulator.push(current);
        }
        return accumulator;
    }, []);
}

function sortByPrice() {
    console.log(chalk.blue('Sorting listings by price'));
    listingData.sort((a, b) => a.price - b.price);
}

function trimResults() {
    filteredListings = uniqueListings.slice(0, 3);

    console.log(chalk.bold('Here are your lowest priced items:'));
    if (filteredListings.length > 0) {
        console.log(chalk.yellow(`🥇 Buy this first: ${filteredListings[0].name}`));
        console.log(chalk.green(`   Price: $${filteredListings[0].price.toFixed(2)}`));
        console.log(chalk.green(`   Condition: ${filteredListings[0].condition}`));
        console.log(chalk.green(`   Link: ${chalk.underline(filteredListings[0].link)}`));
    }
    if (filteredListings.length > 1) {
        console.log(chalk.white(`🥈 Buy this second: ${filteredListings[1].name}`));
        console.log(chalk.green(`   Price: $${filteredListings[1].price.toFixed(2)}`));
        console.log(chalk.green(`   Condition: ${filteredListings[1].condition}`));
        console.log(chalk.green(`   Link: ${chalk.underline(filteredListings[1].link)}`));
    }
    if (filteredListings.length > 2) {
        console.log(chalk.gray(`🥉 Buy this third: ${filteredListings[2].name}`));
        console.log(chalk.green(`   Price: $${filteredListings[2].price.toFixed(2)}`));
        console.log(chalk.green(`   Condition: ${filteredListings[2].condition}`));
        console.log(chalk.green(`   Link: ${chalk.underline(filteredListings[2].link)}`));
    }
    return filteredListings
}

async function fetchBandcampWishlist(username) {
    const url = `https://bandcamp.com/${username}/wishlist`;
    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    const wishlist = [];
    $('.item-link:not(.also-link)').each((index, element) => {
        const title = $(element).find('.collection-item-title').text().trim();
        const artist = $(element).find('.collection-item-artist').text().trim();
        const link = $(element).attr('href');
        wishlist.push({ title, artist, link });
    });
    return wishlist;
}

async function fetchBandcampAlbumDetails(album) {
    const response = await fetch(album.link);
    const html = await response.text();
    const $ = cheerio.load(html);
    const url = "https://api.currencyapi.com/v3/latest";
    let currencies = "AUD";
    let base_currency = "";
    let rate = 10000;

    if ($('h4.notable').text().includes('Sold Out')) {
        return null;
    }

    const priceText = $('li.buyItem.digital span.base-text-color').text().trim();

    if (priceText[0] === "$") {
        base_currency = "USD";
    } else if (priceText[0] === "€") {
        base_currency = "EUR";
    } else if (priceText[0] === "£") {
        base_currency = "GBP";
    }

    await fetch(`${url}?apikey=${process.env.CURRENCY_API_KEY}&currencies=${currencies}&base_currency=${base_currency}`).then(response => {
        return response.json();
    }).then(data => {
        rate = data.data["AUD"]["value"];
    }).catch(error => {
        console.error('Error in currency rate collection', error);
    });

    let price = parseFloat(priceText.slice(1,));
    price = price * rate;

    const imageUrl = $('#tralbumArt img').attr('src');

    return {
        name: `${album.title} by ${album.artist}`,
        price: price,
        condition: 'New',
        sleeve_condition: 'New',
        link: album.link,
        image: imageUrl 
    };
}

async function integrateBandcampData(username) {
    console.log(chalk.blue('Gathering Bandcamp wishlist data'));
    const wishlist = await fetchBandcampWishlist(username);

    const fetchPromises = wishlist.map(album => 
        fetchBandcampAlbumDetails(album)
            .then(albumDetails => {
                if (albumDetails) {
                    listingData.push(albumDetails);
                }
            })
            .catch(error => {
                console.error('Error fetching Bandcamp album details:', error);
            })
    );

    await Promise.all(fetchPromises);
    console.log('Completed integrating Bandcamp data');
}

async function main(dgsUsername, bandcampUsername) {
    let discogsSuccess = true;
    let bandcampSuccess = true;

    if (checkForEnvironmentVariables()) {
        const totalSteps = 5;
        let completedSteps = 0;

        const updateProgress = (stepDescription) => {
            completedSteps++;
            const percentage = Math.round((completedSteps / totalSteps) * 100);
            const eta = Math.round(((totalSteps - completedSteps) * 2));
            sse.send(`Progress: ${percentage}% | ETA: ${eta}s | ${stepDescription}`);
        };

        const discogsTasks = async () => {
            try {
                sse.send('Fetching wantlist');
                await fetchWantlist(dgsUsername);
                updateProgress('Fetched wantlist');

                sse.send('Collecting release IDs');
                await collectReleaseIDs();
                updateProgress('Collected release IDs');

                sse.send('Collecting marketplace IDs');
                await collectMarketplaceIDs();
                updateProgress('Collected marketplace IDs');

                sse.send('Fetching marketplace listing data');
                await fetchMarketplaceListingData();
                updateProgress('Fetched marketplace data');
            } catch (error) {
                console.error('Error processing Discogs data:', error);
                discogsSuccess = false;
            }
        };

        const bandcampTasks = async () => {
            try {
                sse.send('Integrating Bandcamp data');
                await integrateBandcampData(bandcampUsername);
                updateProgress('Integrated Bandcamp data');
            } catch (error) {
                console.error('Error fetching Bandcamp data:', error);
                bandcampSuccess = false;
            }
        };

        await Promise.all([discogsTasks(), bandcampTasks()]);

        if (discogsSuccess || bandcampSuccess) {
            sse.send('Sorting by price');
            sortByPrice();
            updateProgress('Sorted by price');

            sse.send('Removing duplicates');
            removeDuplicates();
            updateProgress('Removed duplicates');

            sse.send('Trimming results');
            const results = trimResults();
            updateProgress('Trimmed results');

            sse.send('Done!');
            return { results, discogsSuccess, bandcampSuccess };
        } else {
            sse.send('Both APIs failed.');
            return { results: [], discogsSuccess, bandcampSuccess };
        }
    }
}

app.use(express.json())

app.post('/fetch-listings', async (req, res) => {
    const { dgs_username, bandcamp_username } = req.body;
    const results = await main(dgs_username, bandcamp_username);
    res.send(results);
})

app.get('/progress', sse.init);

app.listen(port, () => {
    console.log(`Listening on port ${port}`)
})


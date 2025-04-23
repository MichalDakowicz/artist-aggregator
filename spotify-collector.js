const CLIENT_ID = "a2b902956a934854b3e79d20d4ed6ce4";
const REDIRECT_URI = "https://michaldakowicz.github.io/artist-aggregator/";
const SCOPES =
    "playlist-read-private playlist-modify-public playlist-modify-private";
const API_BASE = "https://api.spotify.com/v1";
const ALBUM_FETCH_LIMIT = 50;
const TRACK_FETCH_LIMIT = 50;
const ADD_TRACKS_LIMIT = 100;
const REQUEST_DELAY_MS = 400;
const DURATION_TOLERANCE_MS = 3000;

const loginSection = document.getElementById("login-section");
const appSection = document.getElementById("app-section");
const loginButton = document.getElementById("login-button");
const logoutButton = document.getElementById("logout-button");
const artistInput = document.getElementById("artist-input");
const playlistSelect = document.getElementById("playlist-select");
const startButton = document.getElementById("start-button");
const statusDiv = document.getElementById("status"); 
const progressBarContainer = document.getElementById("progress-bar-container");
const progressBar = document.getElementById("progress-bar");

let accessToken = null;
let tokenExpiresAt = null;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function generateRandomString(length) {
    let text = "";
    const possible =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function updateStatus(message, type = "info") {
    statusDiv.textContent = message;
    statusDiv.style.color =
        type === "error"
            ? "#f15e6c"
            : type === "success"
            ? "#1DB954"
            : "inherit";
    statusDiv.style.fontWeight = "500";
    console.log(`[${type.toUpperCase()}] ${message}`);
}

function showProgress(percentage) {
    progressBarContainer.style.display = "block";
    const clampedPercentage = Math.max(0, Math.min(100, percentage));
    progressBar.style.width = `${clampedPercentage}%`;
}
function hideProgress() {
    progressBarContainer.style.display = "none";
    progressBar.style.width = `0%`;
}
function extractArtistId(linkOrId) {
    if (!linkOrId) return null;
    linkOrId = linkOrId.trim();
    try {
        const url = new URL(linkOrId);
        if (url.hostname === "open.spotify.com") {
            const parts = url.pathname.split("/");
            const artistIndex = parts.indexOf("artist");
            if (artistIndex !== -1 && parts.length > artistIndex + 1) {
                return parts[artistIndex + 1].split("?")[0];
            }
        }
    } catch (_) {
        /* Ignore */
    }
    if (/^[a-zA-Z0-9]{22}$/.test(linkOrId)) {
        return linkOrId;
    }
    return null;
}

function generateTrackContentKey(track) {
    if (
        !track ||
        !track.name ||
        !Array.isArray(track.artists) ||
        typeof track.duration_ms !== "number"
    ) {
        console.warn("Invalid track data for key generation:", track);
        return null;
    }
    const normalizedName = track.name.trim().toLowerCase();
    const artistIds = track.artists
        .map((a) => a.id)
        .filter((id) => id)
        .sort();
    const normalizedArtists = artistIds.join(",");
    const durationGroup = Math.round(track.duration_ms / DURATION_TOLERANCE_MS);
    return `${normalizedName}|${normalizedArtists}|${durationGroup}`;
}

async function spotifyFetch(url, options = {}) {
    if (!accessToken || Date.now() > tokenExpiresAt) {
        updateStatus(
            "Access token is missing or expired. Please log in again.",
            "error"
        );
        logout();
        throw new Error("Token missing or expired");
    }
    const defaultOptions = {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
        },
    };
    const fetchOptions = { ...defaultOptions, ...options };
    if (options.body) {
        fetchOptions.body = JSON.stringify(options.body);
    }
    await delay(REQUEST_DELAY_MS);
    try {
        const response = await fetch(url, fetchOptions);
        if (response.status === 401) {
            updateStatus(
                "Spotify token is invalid or expired. Please log in again.",
                "error"
            );
            logout();
            throw new Error("Spotify API Unauthorized (401)");
        }
        if (response.status === 429) {
            const retryAfter = parseInt(
                response.headers.get("Retry-After") || "5",
                10
            );
            updateStatus(
                `Rate limited by Spotify. Waiting ${retryAfter} seconds...`,
                "error"
            );
            console.warn(`Rate limited. Waiting ${retryAfter} seconds.`);
            await delay(retryAfter * 1000);
            return spotifyFetch(url, options);
        }
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const message =
                errorData?.error?.message || `HTTP Error ${response.status}`;
            console.error(
                `API Error ${response.status}: ${message}`,
                errorData
            );
            throw new Error(`Spotify API Error: ${message}`);
        }
        if (
            response.status === 204 ||
            response.headers.get("content-length") === "0"
        ) {
            return null;
        }
        return await response.json();
    } catch (error) {
        if (!error.message.includes("Spotify API Unauthorized")) {
            updateStatus(`Network or API Error: ${error.message}`, "error");
        }
        throw error;
    }
}
async function fetchPaginatedItems(url) {
    let items = [];
    let nextUrl = url;
    let page = 1;
    while (nextUrl) {
        console.log(`Fetching page ${page}: ${nextUrl}`);
        try {
            const data = await spotifyFetch(nextUrl);
            if (data && data.items) {
                items = items.concat(data.items);
            } else {
                console.warn("Unexpected pagination response structure:", data);
            }
            nextUrl = data?.next;
            page++;
        } catch (error) {
            updateStatus(
                `Error during pagination fetch (page ${page}): ${error.message}`,
                "error"
            );
            throw error;
        }
    }
    return items;
}
async function getUserPlaylists() {
    updateStatus("Loading your playlists...");
    playlistSelect.disabled = true;
    playlistSelect.innerHTML = '<option value="">-- Loading... --</option>';
    try {
        const playlists = await fetchPaginatedItems(
            `${API_BASE}/me/playlists?limit=50`
        );
        playlistSelect.innerHTML =
            '<option value="">-- Select a Playlist --</option>';
        const me = await spotifyFetch(`${API_BASE}/me`);
        const myUserId = me.id;
        const writablePlaylists = playlists.filter(
            (p) => p.owner.id === myUserId || p.collaborative
        );
        if (writablePlaylists.length === 0) {
            playlistSelect.innerHTML =
                '<option value="">No writable playlists found</option>';
            updateStatus(
                "No playlists found that you can add songs to.",
                "error"
            );
            return;
        }
        writablePlaylists.forEach((p) => {
            const option = document.createElement("option");
            option.value = p.id;
            option.textContent = `${p.name} (${p.tracks.total} tracks)`;
            playlistSelect.appendChild(option);
        });
        playlistSelect.disabled = false;
        updateStatus(
            "Playlists loaded. Enter artist link/ID and select playlist."
        );
        checkIfReady();
    } catch (error) {
        playlistSelect.innerHTML =
            '<option value="">Error loading playlists</option>';
        console.error("Failed to load playlists:", error);
    }
}

async function getFilteredArtistTrackUris(targetArtistId) {
    const collectedTracksMap = new Map();
    const releaseTypesToFetch = [
        "album",
        "single",
        "appears_on",
        "compilation",
    ];
    const allReleases = [];
    let initialTrackCount = 0;

    updateStatus("Fetching all relevant releases...");
    let totalFetchedReleaseCount = 0;
    for (const type of releaseTypesToFetch) {
        updateStatus(`Fetching '${type}' releases...`, "info"); 
        let releasesUrl = `${API_BASE}/artists/${targetArtistId}/albums?include_groups=${type}&limit=${ALBUM_FETCH_LIMIT}&market=from_token`;
        try {
            const releases = await fetchPaginatedItems(releasesUrl);
            releases.forEach((release) => {
                allReleases.push({ releaseInfo: release, type: type });
                totalFetchedReleaseCount++;
            });
            updateStatus(
                `Fetched ${releases.length} '${type}'. Total found: ${totalFetchedReleaseCount}`,
                "info"
            );
        } catch (error) {
            updateStatus(
                `Error fetching '${type}' releases: ${error.message}. Skipping.`,
                "error"
            );
        }
    }
    if (allReleases.length === 0) {
        updateStatus("No releases found.", "info");
        return [];
    }

    updateStatus(
        `Processing ${allReleases.length} releases for tracks...`,
        "info"
    );
    let processedReleaseCount = 0;
    const totalReleasesToProcess = allReleases.length;
    for (const { releaseInfo, type } of allReleases) {
        processedReleaseCount++;
        const progress = Math.round(
            (processedReleaseCount / totalReleasesToProcess) * 50
        );
        showProgress(progress);
        updateStatus(
            `Processing Release ${processedReleaseCount}/${totalReleasesToProcess}: [${type}] ${releaseInfo.name}`,
            "info"
        );

        let tracksUrl = `${API_BASE}/albums/${releaseInfo.id}/tracks?limit=${TRACK_FETCH_LIMIT}&market=from_token`;
        let releaseTracks = [];
        try {
            releaseTracks = await fetchPaginatedItems(tracksUrl);
        } catch (error) {
            updateStatus(
                `Error fetching tracks for [${type}] '${releaseInfo.name}': ${error.message}. Skipping.`,
                "error"
            );
            continue;
        }

        for (const track of releaseTracks) {
            if (!track || !track.uri) continue;
            let shouldAdd = false;
            if (type === "album" || type === "single") {
                shouldAdd = true;
            } else if (type === "appears_on" || type === "compilation") {
                if (track.artists && Array.isArray(track.artists)) {
                    shouldAdd = track.artists.some(
                        (artist) => artist && artist.id === targetArtistId
                    );
                }
            }
            if (shouldAdd) {
                initialTrackCount++;
                const contentKey = generateTrackContentKey(track);
                if (contentKey && !collectedTracksMap.has(contentKey)) {
                    collectedTracksMap.set(contentKey, { uri: track.uri });
                }
            }
        }
    }

    const finalTrackUris = Array.from(collectedTracksMap.values()).map(
        (trackData) => trackData.uri
    );
    updateStatus(
        `Found ${initialTrackCount} potential tracks, deduplicated to ${finalTrackUris.length} unique tracks.`,
        "info"
    );
    return finalTrackUris;
}

async function addTracksToPlaylist(playlistId, trackUris) {
    const totalTracks = trackUris.length;
    if (totalTracks === 0) {
        updateStatus("No relevant unique tracks found to add.", "info");
        return;
    }
    updateStatus(
        `Starting to add ${totalTracks} unique tracks to the playlist...`,
        "info"
    );
    let addedCount = 0;
    for (let i = 0; i < totalTracks; i += ADD_TRACKS_LIMIT) {
        const batch = trackUris.slice(i, i + ADD_TRACKS_LIMIT);
        const batchNum = Math.floor(i / ADD_TRACKS_LIMIT) + 1;
        const totalBatches = Math.ceil(totalTracks / ADD_TRACKS_LIMIT);
        const progress = 50 + Math.round((addedCount / totalTracks) * 50);
        showProgress(progress);
        updateStatus(
            `Adding batch ${batchNum}/${totalBatches} (${batch.length} tracks)... Total Added: ${addedCount}/${totalTracks}`,
            "info"
        );
        try {
            await spotifyFetch(`${API_BASE}/playlists/${playlistId}/tracks`, {
                method: "POST",
                body: { uris: batch },
            });
            addedCount += batch.length;
        } catch (error) {
            updateStatus(
                `Error adding batch ${batchNum}: ${error.message}. Stopping. ${addedCount} tracks might have been added.`,
                "error"
            );
            throw error;
        }
    }
    showProgress(100);
    updateStatus(
        `Successfully added ${addedCount} unique tracks to the playlist!`,
        "success"
    );
}

function handleAuthCallback() {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    if (params.has("access_token")) {
        accessToken = params.get("access_token");
        const expiresIn = parseInt(params.get("expires_in") || "3600", 10);
        tokenExpiresAt = Date.now() + expiresIn * 1000;
        sessionStorage.setItem("spotifyAccessToken", accessToken);
        sessionStorage.setItem("spotifyTokenExpiresAt", tokenExpiresAt);
        window.location.hash = "";
        showApp();
        getUserPlaylists();
    } else if (params.has("error")) {
        updateStatus(`Login Error: ${params.get("error")}`, "error");
        showLogin();
    } else {
        const storedToken = sessionStorage.getItem("spotifyAccessToken");
        const storedExpiresAt = parseInt(
            sessionStorage.getItem("spotifyTokenExpiresAt") || "0",
            10
        );
        if (storedToken && Date.now() < storedExpiresAt) {
            accessToken = storedToken;
            tokenExpiresAt = storedExpiresAt;
            showApp();
            getUserPlaylists();
        } else {
            showLogin();
        }
    }
}
function redirectToSpotifyLogin() {
    const state = generateRandomString(16);
    sessionStorage.setItem("spotifyAuthState", state);
    let url = "https://accounts.spotify.com/authorize";
    url += "?response_type=token";
    url += "&client_id=" + encodeURIComponent(CLIENT_ID);
    url += "&scope=" + encodeURIComponent(SCOPES);
    url += "&redirect_uri=" + encodeURIComponent(REDIRECT_URI);
    url += "&state=" + encodeURIComponent(state);
    window.location = url;
}
function logout() {
    accessToken = null;
    tokenExpiresAt = null;
    sessionStorage.removeItem("spotifyAccessToken");
    sessionStorage.removeItem("spotifyTokenExpiresAt");
    sessionStorage.removeItem("spotifyAuthState");
    showLogin();
    playlistSelect.innerHTML =
        '<option value="">-- Log in to load playlists --</option>';
    artistInput.value = "";
    updateStatus("Logged out.", "info");
    hideProgress();
}
function showLogin() {
    loginSection.style.display = "block";
    appSection.style.display = "none";
    startButton.disabled = true;
}
function showApp() {
    loginSection.style.display = "none";
    appSection.style.display = "block";
    checkIfReady();
}
function checkIfReady() {
    const artistId = extractArtistId(artistInput.value);
    const playlistId = playlistSelect.value;
    const ready =
        artistId && playlistId && accessToken && Date.now() < tokenExpiresAt;
    startButton.disabled = !ready;
    startButton.textContent = ready
        ? "Add Collected Songs"
        : "Select Artist & Playlist";
}

async function startProcess() {
    const artistId = extractArtistId(artistInput.value);
    const playlistId = playlistSelect.value;
    if (!artistId || !playlistId) {
        updateStatus("Please select a valid artist and playlist.", "error");
        return;
    }
    startButton.disabled = true;
    artistInput.disabled = true;
    playlistSelect.disabled = true;
    logoutButton.disabled = true;
    updateStatus("Starting: Collecting & Deduplicating songs...", "info");
    hideProgress();
    try {
        const uniqueTrackUris = await getFilteredArtistTrackUris(artistId);
        if (uniqueTrackUris.length === 0) {
            updateStatus("No relevant unique tracks found.", "success");
            hideProgress();
        } else {
            await addTracksToPlaylist(playlistId, uniqueTrackUris);
        }
    } catch (error) {
        console.error("Process failed:", error);
        if (!statusDiv.textContent.includes("Error")) {
            updateStatus(`An error occurred: ${error.message}`, "error");
        }
        hideProgress();
    } finally {
        artistInput.disabled = false;
        playlistSelect.disabled = false;
        logoutButton.disabled = false;
        checkIfReady();
    }
}

loginButton.addEventListener("click", redirectToSpotifyLogin);
logoutButton.addEventListener("click", logout);
startButton.addEventListener("click", startProcess);
artistInput.addEventListener("input", checkIfReady);
playlistSelect.addEventListener("change", checkIfReady);

document.addEventListener("DOMContentLoaded", () => {
    if (!CLIENT_ID || !REDIRECT_URI) {
        updateStatus(
            "Configuration Error: Client ID or Redirect URI missing.",
            "error"
        );
        loginButton.disabled = true;
        return;
    }
    handleAuthCallback();
});

import {
    readFile,
    writeFile,
    readdir,
    unlink,
    mkdir
} from 'fs/promises';
import {
    existsSync
} from 'fs';
import path from 'path';
import https from 'https'; // Import the https module

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Disable TLS certificate validation (not recommended for production)

// --- Configuration ---
const STATIONS_LIST_URL = 'https://sarjtr.epdk.gov.tr:443/sarjet/api/stations';
const STATION_DETAIL_URL_TEMPLATE = 'https://sarjtr.epdk.gov.tr:443/sarjet/api/stations/id/{id}/{dateTime}';

// Directories for storing run data
const STATE_DIR = path.resolve(process.cwd(), 'state');
const OUTPUT_DIR = path.resolve(process.cwd(), 'output');
const LATEST_OUTPUT_FILENAME = 'stations.json'; // Name for the latest complete output file
const STATE_FILENAME_PREFIX = 'data_';
const OUTPUT_FILENAME_PREFIX = 'stations_';
const FILENAME_SUFFIX = '.json';

const MAX_HISTORY_FILES = 10; // Keep the latest 10 state/output file pairs
const MIN_INTERVAL_DAYS_IF_COMPLETE = 7; // Min days before running again if last run was complete

const MAX_REQUESTS_PER_RUN = 1000; // Max detail requests per script execution (stops after this many *requests*)
const MAX_RUN_MINUTES = 15; // Max duration in minutes for processing stations in a single run (stops after this much *time*)
const MAX_RETRIES = 5; // Max retries for failed detail requests (across multiple runs)
const PERMANENT_FAILURE_THRESHOLD_PERCENT = 1; // Max percentage of permanently failed stations to allow before exiting with error code
const REQUEST_DELAY_MS = 500; // Delay between detail requests to be polite
const FETCH_TIMEOUT_MS = 30000; // Timeout for fetch requests (30 seconds)

const FETCH_HEADERS = {
    'User-Agent': 'Dart/3.1 (dart:io)',
    'Accept-Encoding': 'gzip',
    'Host': 'sarjtr.epdk.gov.tr'
};

// Calculate max duration in milliseconds
const MAX_DURATION_MS = MAX_RUN_MINUTES * 60 * 1000;

// Create an HTTPS agent that ignores certificate verification errors
const insecureAgent = new https.Agent({
    rejectUnauthorized: false
});

// --- Helper Functions ---

/**
 * Creates a promise that resolves after a specified delay.
 * @param {number} ms The delay in milliseconds.
 * @returns {Promise<void>}
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));


/**
 * Generates a timestamp string for filenames (YYYYMMDDTHHMMSSZ).
 * Uses UTC time.
 * @returns {string} Formatted timestamp string.
 */
function generateTimestamp() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const hours = String(now.getUTCHours()).padStart(2, '0');
    const minutes = String(now.getUTCMinutes()).padStart(2, '0');
    const seconds = String(now.getUTCSeconds()).padStart(2, '0');
    return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}


/** Extracts timestamp string from filename. */
function getTimestampFromFilename(filename) {
    const baseName = path.basename(filename, FILENAME_SUFFIX);
    if (baseName.startsWith(STATE_FILENAME_PREFIX)) {
        return baseName.substring(STATE_FILENAME_PREFIX.length);
    }
    if (baseName.startsWith(OUTPUT_FILENAME_PREFIX)) {
        return baseName.substring(OUTPUT_FILENAME_PREFIX.length);
    }
    return null;
}

/**
 * Parses a timestamp string (expected format YYYYMMDDTHHMMSSZ) into a Date object.
 * @param {string} timestampStr The timestamp string to parse.
 * @returns {Date | null} The Date object or null if parsing fails.
 */
function parseTimestamp(timestampStr) {
    if (!timestampStr || timestampStr.length !== 16 || timestampStr[8] !== 'T' || timestampStr[15] !== 'Z') {
        console.warn(`Invalid timestamp format received: ${timestampStr}. Expected YYYYMMDDTHHMMSSZ.`);
        return null; // Basic format validation
    }
    try {
        // Reconstruct to standard ISO 8601 format for Date constructor
        const year = timestampStr.substring(0, 4);
        const month = timestampStr.substring(4, 6);
        const day = timestampStr.substring(6, 8);
        const hours = timestampStr.substring(9, 11);
        const minutes = timestampStr.substring(11, 13);
        const seconds = timestampStr.substring(13, 15);
        const isoStr = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`;
        const date = new Date(isoStr);
        // Check if the constructed date is valid
        if (isNaN(date.getTime())) {
            console.warn(`Failed to parse reconstructed ISO string: ${isoStr} from timestamp ${timestampStr}`);
            return null;
        }
        return date;
    } catch (e) {
        console.error(`Error parsing timestamp string "${timestampStr}":`, e);
        return null;
    }
}


/** Ensures a directory exists. */
async function ensureDirectoryExists(dirPath) {
    try {
        await mkdir(dirPath, {recursive: true});
    } catch (error) {
        if (error.code !== 'EEXIST') { // Ignore error if directory already exists
            console.error(`Error creating directory ${dirPath}:`, error);
            throw error; // Re-throw critical errors
        }
    }
}

/** Sorts an array of station objects numerically by their 'id' property. */
function sortStationsById(stations) {
    if (Array.isArray(stations)) {
        stations.sort((a, b) => {
            // Handle potential non-numeric IDs gracefully during sort
            const idA = typeof a?.id === 'number' ? a.id : -Infinity;
            const idB = typeof b?.id === 'number' ? b.id : -Infinity;
            return idA - idB;
        });
    }
}

/** Converts a string to Turkish locale-aware title case. */
function toTitleCase(str) {
    if (!str) return null;
    const lowerCaseStr = str.toLocaleLowerCase('tr-TR');
    return lowerCaseStr.replace(/(^|\s|\/)([a-zıöüçşğ])/g, (match, separator, letter) => {
        return separator + letter.toLocaleUpperCase('tr-TR');
    });
}

/** Converts a string from SNAKE_CASE or other formats to lower camel case. */
function toLowerCamelCase(str) {
    if (!str) return null;
    return str
        .toLowerCase()
        .split(/[-_ ]+/)
        .map((word, index) => index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1))
        .join('');
}

/**
 * Gets the current date and time formatted for the API URL.
 * Format: YYYY-MM-DD HH:MM:SS (using local time)
 * @returns {string} The formatted date-time string.
 */
function getCurrentDateTimeString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}


/** Normalizes a station data object for consistency. */
function normalizeStationData(station) {
    if (!station || typeof station !== 'object' || !station.id) {
        console.warn("Invalid station object received for normalization:", station);
        return null;
    }
    const normalizedStation = {};
    normalizedStation.id = parseInt(station.id, 10);
    normalizedStation.lat = parseFloat(station.lat);
    normalizedStation.lng = parseFloat(station.lng);
    normalizedStation.title = toTitleCase(station.title?.trim());
    normalizedStation.address = toTitleCase(station.address?.trim());
    normalizedStation.phone = station.phone?.trim() || null;
    normalizedStation.reportUrl = station.reportUrl?.trim() || null;
    normalizedStation.reservationUrl = station.reservationUrl?.trim() || null;
    normalizedStation.operatorId = station.operatorid || null;
    normalizedStation.operatorTitle = toTitleCase(station.operatortitle?.trim());
    const serviceTypeLower = station.serviceType?.toLowerCase().trim();
    if (serviceTypeLower === 'halka_acik') {
        normalizedStation.serviceType = 'public';
    } else {
        normalizedStation.serviceType = serviceTypeLower || null;
    }
    normalizedStation.brand = station.brand?.trim() || null;
    normalizedStation.cityId = station.cityid || null;
    normalizedStation.districtId = station.districtid || null;
    normalizedStation.sockets = [];
    if (Array.isArray(station.sockets)) {
        normalizedStation.sockets = station.sockets.map(socket => {
            if (!socket || typeof socket !== 'object' || !socket.id) {
                console.warn(`Invalid socket object found in station ${station.id}:`, socket);
                return null;
            }
            const normalizedSocket = {};
            normalizedSocket.id = parseInt(socket.id, 10);
            normalizedSocket.type = socket.type?.toLowerCase().trim() || null;
            normalizedSocket.subType = toLowerCamelCase(socket.subType?.trim());
            normalizedSocket.socketNumber = socket.socketNumber?.trim() || null;
            const power = parseFloat(socket.power);
            normalizedSocket.power = isNaN(power) ? null : power;
            return normalizedSocket;
        }).filter(socket => socket !== null);
        normalizedStation.sockets.sort((a, b) => a.id - b.id);
    }
    return normalizedStation;
}


/** Saves the final normalized station data to a specific file path. */
async function saveFinalOutput(finalStations, outputPath) {
    try {
        sortStationsById(finalStations);
        await writeFile(outputPath, JSON.stringify(finalStations, null, 2), 'utf-8');
        console.log(` -> Final normalized station data saved to ${outputPath}.`);
    } catch (error) {
        console.error(`   Error writing final output file ${outputPath}:`, error);
    }
}

/** Cleans and normalizes the state data. */
function createCleanedOutputData(state) {
    return state.map(station => {
        let outputStation;
        const baseId = parseInt(station.id, 10); // Define baseId once here
        if (isNaN(baseId)) {
            console.warn(`Skipping station with invalid base ID in state: ${station.id}`);
            return null;
        }
        const baseLat = parseFloat(station.lat);
        const baseLng = parseFloat(station.lng);

        if (station.fetchStatus === 'success' && station.details) {
            outputStation = normalizeStationData(station.details);
        } else {
            // Create a basic output object if details are missing or fetch failed
            outputStation = {
                id: baseId,
                lat: isNaN(baseLat) ? null : baseLat,
                lng: isNaN(baseLng) ? null : baseLng,
                title: null,
                address: null,
                phone: null,
                reportUrl: null,
                reservationUrl: null,
                operatorId: null,
                operatorTitle: null,
                serviceType: null,
                brand: null,
                cityId: null,
                districtId: null,
                sockets: Array.isArray(station.sockets) ? station.sockets.map(s => {
                    const socketId = parseInt(s.id, 10);
                    return isNaN(socketId) ? null : {id: socketId};
                }).filter(s => s !== null) : []
            };
            if (outputStation.sockets) {
                outputStation.sockets.sort((a, b) => a.id - b.id);
            }
        }

        // Ensure ID is correct even if normalization failed but base ID was valid
        if (outputStation) {
            outputStation.id = baseId; // Overwrite/ensure ID from base state
        } else {
            // This case should be rare now with the check at the start, but keep as fallback
            console.warn(`Normalization failed for station ${baseId}, outputting basic info.`);
            outputStation = {
                id: baseId,
                lat: isNaN(baseLat) ? null : baseLat,
                lng: isNaN(baseLng) ? null : baseLng,
                sockets: []
            };
        }

        return outputStation;
    }).filter(station => station !== null);
}


/** Reads state data from a specific file path. */
async function loadState(stateFilePath) {
    if (!existsSync(stateFilePath)) {
        console.log(`State file not found at ${stateFilePath}.`);
        return null;
    }
    try {
        const data = await readFile(stateFilePath, 'utf-8');
        const stations = JSON.parse(data);
        if (!Array.isArray(stations)) {
            throw new Error(`State file ${stateFilePath} does not contain a valid JSON array.`);
        }
        sortStationsById(stations); // Sort loaded stations
        console.log(`State loaded and sorted successfully from ${stateFilePath}.`);
        return stations;
    } catch (error) {
        console.error(`Error reading or parsing state file ${stateFilePath}:`, error);
        return null;
    }
}

/** Saves the current state and its corresponding normalized output to specific file paths. */
async function saveState(state, stateFilePath, outputFilePath) {
    if (!Array.isArray(state)) {
        console.error("Attempted to save invalid state (not an array). Aborting save.");
        return;
    }
    try {
        sortStationsById(state);
        await writeFile(stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
        console.log(` -> State saved successfully to ${stateFilePath}.`);

        // Generate and save corresponding normalized output file
        const finalStations = createCleanedOutputData(state);
        await saveFinalOutput(finalStations, outputFilePath);

    } catch (error) {
        console.error(`Error writing state file ${stateFilePath}:`, error);
    }
}

/** Fetches the initial list of stations. */
async function fetchStationList() {
    console.log(`Fetching station list from ${STATIONS_LIST_URL}...`);
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(STATIONS_LIST_URL, {headers: FETCH_HEADERS, signal: signal, agent: insecureAgent});
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status} ${response.statusText} fetching station list.`);
        }
        const stations = await response.json();
        if (!Array.isArray(stations)) {
            throw new Error('API response is not a valid JSON array for station list.');
        }
        sortStationsById(stations);
        console.log(`Successfully fetched and sorted ${stations.length} stations.`);
        return stations.map(station => ({
            id: station.id, lat: station.lat, lng: station.lng,
            sockets: station.sockets || [],
            fetchStatus: 'pending', fetchAttempts: 0, lastAttemptTimestamp: null, details: null, errorInfo: null,
        }));
    } catch (error) {
        if (error.name === 'TimeoutError') {
            console.error(`Timeout fetching station list from ${STATIONS_LIST_URL}.`);
        } else if (error.cause && error.cause.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
            console.error(`Certificate validation error fetching station list: ${error.cause.message}. Attempted bypass.`);
        } else if (error.cause && error.cause.message && error.cause.message.includes('unable to verify the first certificate')) {
            console.error(`Certificate validation error fetching station list: ${error.cause.message}. Attempted bypass.`);
        } else {
            console.error(`Error fetching station list:`, error);
        }
        throw error;
    }
}

/** Fetches details for a single station. */
async function fetchStationDetails(station) {
    const currentDateTime = getCurrentDateTimeString();
    const url = STATION_DETAIL_URL_TEMPLATE.replace('{id}', station.id).replace('{dateTime}', encodeURIComponent(currentDateTime));
    console.log(` -> Fetching details for station ${station.id}...`);
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, {headers: FETCH_HEADERS, signal: signal, agent: insecureAgent});
        if (!response.ok) {
            let errorDetails = `HTTP error ${response.status} ${response.statusText}`;
            try {
                const errorBodyText = await response.text();
                errorDetails += ` - Body: ${errorBodyText.substring(0, 200)}`;
            } catch (_) {
            }
            return {success: false, details: null, error: errorDetails};
        }
        const details = await response.json();
        if (typeof details !== 'object' || details === null || !details.id) {
            throw new SyntaxError(`Invalid JSON structure received for station ${station.id} details.`);
        }
        return {success: true, details: details, error: null};
    } catch (error) {
        let errorMessage;
        let logFullError = true;
        if (error.name === 'TimeoutError') {
            errorMessage = `Timeout fetching details for station ${station.id} from ${url}.`;
            logFullError = false;
        } else if (error instanceof SyntaxError) {
            errorMessage = `Failed to parse or invalid JSON response for station ${station.id}: ${error.message}`;
        } else if (error.cause && error.cause.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
            errorMessage = `Certificate validation error for station ${station.id}: ${error.cause.message}. Attempted bypass.`;
        } else if (error.cause && error.cause.message && error.cause.message.includes('unable to verify the first certificate')) {
            errorMessage = `Certificate validation error for station ${station.id}: ${error.cause.message}. Attempted bypass.`;
        } else {
            errorMessage = `Network or unexpected error for station ${station.id}: ${error.message || error}`;
        }
        if (logFullError || errorMessage.includes('Certificate validation error') || errorMessage.includes('JSON')) {
            console.error(`Full error details for station ${station.id}:`, error);
        }
        return {success: false, details: null, error: errorMessage};
    }
}

/** Checks if the state indicates all processing is complete (no pending or retryable stations). */
function isStateComplete(stations) {
    if (!Array.isArray(stations)) return false;
    return !stations.some(s => s && (s.fetchStatus === 'pending' || (s.fetchStatus === 'failed' && s.fetchAttempts < MAX_RETRIES)));
}

/** Checks if the state contains any permanently failed stations (retries exhausted). */
function hasPermanentlyFailedStations(stations) {
    if (!Array.isArray(stations)) return false; // Or maybe true, depending on desired behavior for invalid state
    return stations.some(s => s && s.fetchStatus === 'failed' && s.fetchAttempts >= MAX_RETRIES);
}

/** Counts the number of permanently failed stations */
function countPermanentlyFailedStations(stations) {
    if (!Array.isArray(stations)) return 0;
    return stations.filter(s => s && s.fetchStatus === 'failed' && s.fetchAttempts >= MAX_RETRIES).length;
}


/**
 * Processes stations for the current run, respecting request and time limits.
 * @param {Array} stations The station data array.
 * @param {string} stateFilePath Path to save the state file.
 * @param {string} outputFilePath Path to save the corresponding output file.
 * @param {number} scriptStartTime Timestamp (ms) when the script started execution.
 * @returns {Promise<boolean>} True if the function completed normally, false on critical error.
 */
async function processStations(stations, stateFilePath, outputFilePath, scriptStartTime) {
    if (!Array.isArray(stations)) {
        console.error("processStations called with invalid 'stations' data. Aborting processing.");
        return false; // Indicate failure
    }
    const stationsToProcess = stations
        .filter(s => s && (s.fetchStatus === 'pending' || (s.fetchStatus === 'failed' && s.fetchAttempts < MAX_RETRIES)))
        .slice(0, MAX_REQUESTS_PER_RUN); // Apply request limit first

    if (stationsToProcess.length === 0) {
        console.log("No stations need processing in this run.");
        // Save state one last time for consistency, even if no work done
        await saveState(stations, stateFilePath, outputFilePath);
        return true; // Indicate success (no processing needed is not a failure)
    }

    console.log(`Starting processing run. Max requests: ${MAX_REQUESTS_PER_RUN}, Max duration: ${MAX_RUN_MINUTES} mins. Stations to process in this batch: ${stationsToProcess.length}`);
    let processedCount = 0, successCount = 0, failureCount = 0;
    let timeLimitReached = false;

    for (const station of stationsToProcess) {
        // Check time limit *before* starting work on this station
        const elapsedTime = Date.now() - scriptStartTime;
        if (elapsedTime >= MAX_DURATION_MS) {
            console.log(`\n[INFO] Maximum run time (${MAX_RUN_MINUTES} minutes) reached. Stopping processing for this run.`);
            timeLimitReached = true;
            break; // Exit the processing loop
        }

        if (!station || !station.id) {
            console.warn("Skipping invalid station object during processing loop:", station);
            processedCount++; // Still count it as 'processed' for loop control
            continue;
        }
        const stationIndex = stations.findIndex(s => s && s.id === station.id);
        if (stationIndex === -1) {
            console.warn(`Station ${station.id} from processing list not found in main state array. Skipping.`);
            processedCount++; // Still count it as 'processed' for loop control
            continue; // Safety check
        }

        // Apply delay *before* fetching
        if (processedCount > 0) await delay(REQUEST_DELAY_MS);

        const result = await fetchStationDetails(station);

        // Update the station object *in place* within the main sorted 'stations' array
        stations[stationIndex].lastAttemptTimestamp = new Date().toISOString();

        if (result.success) {
            stations[stationIndex].details = result.details; // Store raw details
            stations[stationIndex].fetchStatus = 'success';
            stations[stationIndex].fetchAttempts += 1; // Increment attempts even on success for tracking? No, keep 0 for success? Let's increment to show it *was* attempted.
            stations[stationIndex].errorInfo = null;
            successCount++;
            console.log(`   [OK] Station ${station.id} details fetched.`);
        } else {
            stations[stationIndex].fetchAttempts += 1;
            stations[stationIndex].errorInfo = result.error;
            failureCount++;
            if (stations[stationIndex].fetchAttempts >= MAX_RETRIES) {
                stations[stationIndex].fetchStatus = 'failed'; // Mark as terminally failed
                console.error(`   [FAIL] Station ${station.id} failed after ${stations[stationIndex].fetchAttempts} attempts (max ${MAX_RETRIES} reached): ${result.error}`);
            } else {
                stations[stationIndex].fetchStatus = 'failed'; // Mark as failed, eligible for retry in a *future* run
                console.warn(`   [WARN] Station ${station.id} failed attempt ${stations[stationIndex].fetchAttempts}/${MAX_RETRIES}. Will retry in next run if needed. Error: ${result.error}`);
            }
        }
        processedCount++;

        // Save state (and normalized output) frequently, but not if time limit was just hit
        if (!timeLimitReached && (processedCount % 10 === 0 || processedCount === stationsToProcess.length)) {
            await saveState(stations, stateFilePath, outputFilePath);
            console.log(`   Progress saved. Processed ${processedCount}/${stationsToProcess.length} stations in this run.`);
        }
    }

    // Save final state after the loop finishes (either naturally or by time limit)
    // This ensures the very last updates or the state when time ran out is saved.
    await saveState(stations, stateFilePath, outputFilePath);
    console.log(`   Final state saved for this run.`);

    if (timeLimitReached) {
        console.log(`Processing run stopped due to time limit. Processed in this run: ${processedCount} (Success: ${successCount}, Failures: ${failureCount})`);
    } else {
        console.log(`Processing run finished. Success: ${successCount}, Failures: ${failureCount}. Total processed in this run: ${processedCount}.`);
    }
    return true; // Indicate processing function completed its logic
}

/** Manages cleanup of old state and output files. */
async function cleanupOldFiles() {
    console.log(`\n--- Cleaning up old files (keeping latest ${MAX_HISTORY_FILES}) ---`);
    try {
        const stateFiles = (await readdir(STATE_DIR))
            .filter(f => f.startsWith(STATE_FILENAME_PREFIX) && f.endsWith(FILENAME_SUFFIX))
            .sort((a, b) => b.localeCompare(a)); // Sort descending (latest first)

        if (stateFiles.length > MAX_HISTORY_FILES) {
            const filesToDelete = stateFiles.slice(MAX_HISTORY_FILES); // Get the oldest files
            console.log(`Found ${stateFiles.length} state files, deleting ${filesToDelete.length} oldest ones.`);
            for (const stateFilename of filesToDelete) {
                const timestamp = getTimestampFromFilename(stateFilename);
                if (!timestamp) continue;

                const stateFilePath = path.join(STATE_DIR, stateFilename);
                const outputFilename = `${OUTPUT_FILENAME_PREFIX}${timestamp}${FILENAME_SUFFIX}`;
                const outputFilePath = path.join(OUTPUT_DIR, outputFilename);

                try {
                    await unlink(stateFilePath);
                    console.log(`   Deleted old state file: ${stateFilePath}`);
                } catch (err) {
                    if (err.code !== 'ENOENT') console.error(`   Error deleting old state file ${stateFilePath}:`, err);
                }
                try {
                    if (existsSync(outputFilePath)) {
                        await unlink(outputFilePath);
                        console.log(`   Deleted old output file: ${outputFilePath}`);
                    }
                } catch (err) {
                    if (err.code !== 'ENOENT') console.error(`   Error deleting old output file ${outputFilePath}:`, err);
                }
            }
        } else {
            console.log(`Found ${stateFiles.length} state files, no cleanup needed.`);
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log("State directory not found, skipping cleanup.");
        } else {
            console.error("Error during file cleanup:", error);
        }
    }
}

/**
 * Finds the latest complete run and copies its output to stations.json.
 * This function searches historical files.
 */
async function updateLatestCompleteOutput() {
    console.log(`\n--- Updating ${LATEST_OUTPUT_FILENAME} ---`);
    let latestCompleteStateFile = null;
    let latestCompleteTimestamp = null;

    try {
        const stateFiles = (await readdir(STATE_DIR))
            .filter(f => f.startsWith(STATE_FILENAME_PREFIX) && f.endsWith(FILENAME_SUFFIX))
            .sort((a, b) => b.localeCompare(a)); // Sort descending (latest first)

        for (const stateFilename of stateFiles) {
            const stateFilePath = path.join(STATE_DIR, stateFilename);
            console.log(`   Checking state file: ${stateFilename}...`);
            const stations = await loadState(stateFilePath); // Use loadState to read and parse

            if (!stations) {
                console.log(`   Skipping check for ${stateFilename} due to load error.`);
                continue;
            }

            const totalCount = stations.length;
            const permFailedCount = countPermanentlyFailedStations(stations);
            const permFailedPercent = totalCount > 0 ? (permFailedCount / totalCount) * 100 : 0;

            // Check if complete AND permanent failures are below threshold
            if (isStateComplete(stations)) {
                if (permFailedPercent <= PERMANENT_FAILURE_THRESHOLD_PERCENT) {
                    latestCompleteStateFile = stateFilename;
                    latestCompleteTimestamp = getTimestampFromFilename(stateFilename);
                    console.log(`   Found latest usable complete state: ${latestCompleteStateFile} (${permFailedCount} permanent failures, ${permFailedPercent.toFixed(1)}% <= ${PERMANENT_FAILURE_THRESHOLD_PERCENT}%)`);
                    break; // Stop searching
                } else {
                    console.log(`   State ${stateFilename} is complete but has too many permanent failures (${permFailedCount}, ${permFailedPercent.toFixed(1)}% > ${PERMANENT_FAILURE_THRESHOLD_PERCENT}%).`);
                }
            } else {
                console.log(`   State ${stateFilename} is not complete.`);
            }
        }

        if (latestCompleteTimestamp) {
            const sourceOutputFilename = `${OUTPUT_FILENAME_PREFIX}${latestCompleteTimestamp}${FILENAME_SUFFIX}`;
            const sourceOutputPath = path.join(OUTPUT_DIR, sourceOutputFilename);
            const targetOutputPath = path.resolve(process.cwd(), LATEST_OUTPUT_FILENAME);

            if (existsSync(sourceOutputPath)) {
                try {
                    // Read the content of the specific output file
                    const content = await readFile(sourceOutputPath, 'utf-8');
                    // Write it to the top-level stations.json
                    await writeFile(targetOutputPath, content, 'utf-8');
                    console.log(`Successfully updated ${LATEST_OUTPUT_FILENAME} from ${sourceOutputFilename}.`);
                } catch (copyError) {
                    console.error(`Error copying ${sourceOutputFilename} to ${LATEST_OUTPUT_FILENAME}:`, copyError);
                }
            } else {
                console.warn(`   Corresponding output file not found for latest usable state: ${sourceOutputPath}`);
            }
        } else {
            console.log(`   No usable complete state file found (completed and within failure threshold). ${LATEST_OUTPUT_FILENAME} not updated.`);
        }

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`   State or Output directory not found. Cannot update ${LATEST_OUTPUT_FILENAME}.`);
        } else {
            console.error(`Error searching for latest complete state:`, error);
        }
    }
    console.log(`--- Finished updating ${LATEST_OUTPUT_FILENAME} ---`);
}


// --- Main Execution ---
(async () => {
    const scriptStartTime = Date.now(); // Record start time for duration check
    let exitCode = 0; // Default to success
    let currentStations = null;
    let currentStateFilePath = null;
    let currentOutputFilePath = null;
    let runPerformedProcessing = false; // Flag to track if processing actually happened

    console.log("--- Starting EV Station Data Fetcher ---");

    try {
        // Ensure directories exist
        await ensureDirectoryExists(STATE_DIR);
        await ensureDirectoryExists(OUTPUT_DIR);

        // --- Determine Run State ---
        let latestStateFilePath = null;
        let latestTimestamp = null;
        let startNewRun = true; // Assume new run unless we find an incomplete one

        const stateFiles = (await readdir(STATE_DIR))
            .filter(f => f.startsWith(STATE_FILENAME_PREFIX) && f.endsWith(FILENAME_SUFFIX))
            .sort((a, b) => b.localeCompare(a)); // Sort descending (latest first)

        if (stateFiles.length > 0) {
            latestStateFilePath = path.join(STATE_DIR, stateFiles[0]);
            console.log(`Latest state file found: ${latestStateFilePath}`);
            currentStations = await loadState(latestStateFilePath); // Attempt to load
            if (currentStations) {
                const totalCount = currentStations.length;
                const permFailedCount = countPermanentlyFailedStations(currentStations);
                const permFailedPercent = totalCount > 0 ? (permFailedCount / totalCount) * 100 : 0;
                const isLatestComplete = isStateComplete(currentStations);
                const latestTimestamp = getTimestampFromFilename(stateFiles[0]);
                const latestDate = parseTimestamp(latestTimestamp);

                // Decide if we need to continue processing this state
                // Continue if it's NOT complete, OR if it IS complete but EXCEEDS the failure threshold (meaning it wasn't 'good enough' last time)
                const needsProcessing = !isLatestComplete || (isLatestComplete && permFailedPercent > PERMANENT_FAILURE_THRESHOLD_PERCENT);

                if (needsProcessing) {
                    startNewRun = false;
                    currentStateFilePath = latestStateFilePath;
                    currentOutputFilePath = path.join(OUTPUT_DIR, `${OUTPUT_FILENAME_PREFIX}${latestTimestamp}${FILENAME_SUFFIX}`);
                    const reason = !isLatestComplete ? "incomplete" : `exceeded failure threshold (${permFailedPercent.toFixed(1)}% > ${PERMANENT_FAILURE_THRESHOLD_PERCENT}%)`;
                    console.log(`Continuing run from ${latestTimestamp} (${reason})...`);
                } else if (latestDate) { // State is complete AND within failure threshold
                    const daysAgo = (new Date() - latestDate) / (1000 * 60 * 60 * 24);
                    if (daysAgo < MIN_INTERVAL_DAYS_IF_COMPLETE) {
                        console.log(`Last run was usable and completed ${daysAgo.toFixed(1)} days ago (less than ${MIN_INTERVAL_DAYS_IF_COMPLETE} days). No new run needed.`);
                        await updateLatestCompleteOutput(); // Ensure stations.json reflects this state
                        await cleanupOldFiles(); // Still cleanup
                        process.exit(0); // Exit successfully
                    } else {
                        console.log(`Last usable run completed ${daysAgo.toFixed(1)} days ago. Starting a fresh run.`);
                        startNewRun = true; // Force new run
                    }
                } else {
                    // Could not parse timestamp from latest file, better to start fresh
                    console.warn(`Could not parse timestamp from ${stateFiles[0]}. Starting a fresh run.`);
                    startNewRun = true;
                }
            } else {
                // Failed to load latest state file, treat as needing a fresh start
                console.warn(`Failed to load latest state file ${latestStateFilePath}. Starting a fresh run.`);
                startNewRun = true;
            }
        } else {
            console.log("No existing state files found. Starting initial run.");
            startNewRun = true;
        }

        // --- Initialize or Fetch Data ---
        if (startNewRun) {
            const newTimestamp = generateTimestamp(); // Use refined generateTimestamp
            currentStateFilePath = path.join(STATE_DIR, `${STATE_FILENAME_PREFIX}${newTimestamp}${FILENAME_SUFFIX}`);
            currentOutputFilePath = path.join(OUTPUT_DIR, `${OUTPUT_FILENAME_PREFIX}${newTimestamp}${FILENAME_SUFFIX}`);
            console.log(`Starting new run with timestamp ${newTimestamp}.`);
            console.log(`   State file: ${currentStateFilePath}`);
            console.log(`   Output file: ${currentOutputFilePath}`);
            try {
                currentStations = await fetchStationList();
                // Initial save immediately after fetching list
                await saveState(currentStations, currentStateFilePath, currentOutputFilePath);
            } catch (error) {
                console.error("CRITICAL: Failed to fetch initial station list. Cannot proceed.");
                exitCode = 1; // Set error exit code for critical failure
                // Skip further processing and jump towards finally block
                currentStations = null; // Prevent further processing attempts
            }
        }

        // --- Process Stations ---
        if (currentStations && currentStateFilePath && currentOutputFilePath) {
            const needsProcessingCheck = !isStateComplete(currentStations); // Check if processing is needed *before* the run
            if (needsProcessingCheck) {
                // Pass scriptStartTime to processStations
                await processStations(currentStations, currentStateFilePath, currentOutputFilePath, scriptStartTime);
                runPerformedProcessing = true; // Mark that processing occurred
            } else {
                console.log("Loaded state is already complete. No processing needed for this run.");
                // If we loaded a complete state, ensure its output file is consistent
                if (!startNewRun) { // Only save if we loaded an existing complete state
                    await saveState(currentStations, currentStateFilePath, currentOutputFilePath);
                }
            }

            // --- Determine Exit Code (Threshold Logic) ---
            const totalStations = currentStations.length;
            const permanentlyFailedCount = countPermanentlyFailedStations(currentStations);
            const permanentlyFailedPercent = totalStations > 0 ? (permanentlyFailedCount / totalStations) * 100 : 0;
            const finalStateIsComplete = isStateComplete(currentStations);

            if (permanentlyFailedCount > 0) {
                console.log(`\nRun finished. Found ${permanentlyFailedCount} permanently failed stations out of ${totalStations} (${permanentlyFailedPercent.toFixed(1)}%).`);
                if (permanentlyFailedPercent > PERMANENT_FAILURE_THRESHOLD_PERCENT) {
                    console.error(`ERROR: Permanent failure rate (${permanentlyFailedPercent.toFixed(1)}%) exceeds threshold (${PERMANENT_FAILURE_THRESHOLD_PERCENT}%). Exiting with error code 1.`);
                    exitCode = 1;
                } else {
                    console.warn(`WARNING: Permanent failure rate (${permanentlyFailedPercent.toFixed(1)}%) is within threshold (${PERMANENT_FAILURE_THRESHOLD_PERCENT}%). Exiting cleanly (0).`);
                    exitCode = 0; // Treat as success if within threshold
                }
            } else {
                // No permanent failures
                exitCode = 0; // Success
                if (!finalStateIsComplete) {
                    console.warn("\nWARNING: Run finished, but processing is incomplete (pending/retryable stations remain, or time/request limit reached). Exiting cleanly (0).");
                } else {
                    console.log("\nProcessing complete. All stations fetched successfully or failed within threshold. Exiting cleanly (0).");
                }
            }


            // --- Print Summary ---
            const validStations = currentStations.filter(s => s && typeof s === 'object');
            const pendingCount = validStations.filter(s => s.fetchStatus === 'pending').length;
            const retryableCount = validStations.filter(s => s.fetchStatus === 'failed' && s.fetchAttempts < MAX_RETRIES).length;
            const successCount = validStations.filter(s => s.fetchStatus === 'success').length;
            // Permanently failed count already calculated

            console.log("\n--- Fetch Summary ---");
            console.log(`Total Stations in State: ${totalStations}`);
            if (totalStations !== validStations.length) {
                console.warn(`WARNING: Found ${totalStations - validStations.length} invalid entries in state data.`);
            }
            console.log(`Successfully Fetched: ${successCount}`);
            console.log(`Pending (Not Attempted): ${pendingCount}`);
            console.log(`Needs Retry in Future Run (${retryableCount} stations)`);
            console.log(`Permanently Failed (${permanentlyFailedCount} stations)`);
            console.log("---------------------\n");


        } else if (exitCode === 0) { // Handle case where initial fetch failed
            console.error("CRITICAL: Station data is missing or file paths are invalid. Cannot proceed.");
            exitCode = 1;
        }

        // --- Update Latest Complete Output File (Conditional) ---
        // Only update stations.json if the script is exiting successfully (exitCode 0)
        // This means the run was either fully complete with no errors,
        // incomplete without permanent errors, OR complete with permanent errors below the threshold.
        if (exitCode === 0) {
            await updateLatestCompleteOutput();
        } else {
            console.log(`\nSkipping update of ${LATEST_OUTPUT_FILENAME} due to script exiting with non-zero status.`);
        }

        // --- Cleanup ---
        await cleanupOldFiles();

    } catch (error) {
        console.error("\n--- UNHANDLED ERROR OCCURRED ---");
        console.error(error);
        exitCode = 1; // Ensure non-zero exit on unexpected errors
    } finally {
        const scriptEndTime = Date.now();
        const totalDurationSec = ((scriptEndTime - scriptStartTime) / 1000).toFixed(1);
        console.log(`\nScript finished in ${totalDurationSec} seconds with exit code ${exitCode}.`);
        process.exit(exitCode);
    }
})();

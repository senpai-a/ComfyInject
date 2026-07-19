import { hasImageMarker, parseImageMarkers, generateParsedMarker } from "./parse.js";
import { generateImage } from "./comfy.js";
import { saveLastSeed, getImageData } from "./state.js";
import { MODULE_NAME } from "../settings.js";

/**
 * Builds the <img> tag string that gets injected into the message.
 * Stores prompt and seed as data attributes for outbound.js to read.
 * @param {string} imageUrl - The full ComfyUI /view URL
 * @param {string} prompt - The raw prompt returned by generateImage()
 * @param {number} seed - The resolved seed used for generation
 * @returns {string} The HTML img tag string
 */
function buildImgTag(imageUrl, prompt, seed) {
    return `<img class="comfyinject-image" src="${imageUrl}" data-prompt="${prompt.replace(/"/g, '&quot;')}" data-seed="${seed}" />`;
}

/**
 * Finds the current array index of a message by its send_date.
 * @param {string} sendDate - The send_date to look for
 * @returns {number} The current index, or -1 if not found
 */
function findIndexBySendDate(sendDate) {
    const context = SillyTavern.getContext();
    for (let i = 0; i < context.chat.length; i++) {
        if (context.chat[i].send_date === sendDate) return i;
    }
    return -1;
}

/**
 * Returns the current marker repair toast mode.
 * @returns {"all" | "failures" | "off"}
 */
function getRepairToastMode() {
    return SillyTavern.getContext().extensionSettings[MODULE_NAME]?.repair_toast_mode || "failures";
}

/**
 * Returns true if a repairMeta object contains any meaningful repair info.
 * Non-canonical formatting alone does not count unless something was actually
 * defaulted, ignored, or flagged.
 * @param {object|null} repairMeta
 * @returns {boolean}
 */
function hasMeaningfulRepair(repairMeta) {
    if (!repairMeta || typeof repairMeta !== "object") return false;

    const defaulted = Array.isArray(repairMeta.defaulted) ? repairMeta.defaulted : [];
    const duplicateTokens = repairMeta.duplicateTokens || {};

    const duplicateAr = Array.isArray(duplicateTokens.AR) ? duplicateTokens.AR : [];
    const duplicateShot = Array.isArray(duplicateTokens.SHOT) ? duplicateTokens.SHOT : [];
    const duplicateSeed = Array.isArray(duplicateTokens.SEED) ? duplicateTokens.SEED : [];

    return (
        defaulted.length > 0 ||
        duplicateAr.length > 0 ||
        duplicateShot.length > 0 ||
        duplicateSeed.length > 0 ||
        repairMeta.possibleSeedInPrompt === true
    );
}

/**
 * Shows a grouped repair toast for one live-rendered message.
 * This is only used for successful repaired markers.
 * @param {number} repairedCount
 * @param {number} totalCount
 */
function maybeShowGroupedRepairToast(repairedCount, totalCount) {
    if (getRepairToastMode() !== "all") return;
    if (repairedCount <= 0) return;

    toastr.warning(
        `Repaired ${repairedCount}/${totalCount} markers in this message. See Image Gallery for details.`,
        "ComfyInject"
    );
}

/**
 * Logs a grouped repair warning for one live-rendered message.
 * This mirrors the user-facing grouped repair toast.
 * @param {number} messageIndex
 * @param {number} repairedCount
 * @param {number} totalCount
 */
function maybeLogGroupedRepairWarning(messageIndex, repairedCount, totalCount) {
    if (getRepairToastMode() !== "all") return;
    if (repairedCount <= 0) return;

    console.warn("[ComfyInject] Repaired markers in message:", {
        messageIndex,
        repairedCount,
        totalCount,
    });
}

/**
 * Shows a parse-failure toast based on the user's marker repair toast setting.
 * @param {string} errorText
 */
function maybeShowParseFailureToast(errorText) {
    const mode = getRepairToastMode();
    if (mode === "off") return;

    toastr.warning(errorText, "ComfyInject");
}

/**
 * Shows one bulk-scan repair summary toast after scanning old messages.
 * This avoids spamming one toast per message during chat load.
 * @param {number} repairedMessages
 * @param {number} repairedMarkers
 */
function maybeShowBulkRepairSummaryToast(repairedMessages, repairedMarkers) {
    if (getRepairToastMode() !== "all") return;
    if (repairedMarkers <= 0) return;

    toastr.warning(
        `Repaired ${repairedMarkers} markers across ${repairedMessages} existing messages. See Image Gallery for details.`,
        "ComfyInject"
    );
}

/**
 * Logs one bulk-scan repair summary warning after scanning old messages.
 * @param {number} repairedMessages
 * @param {number} repairedMarkers
 */
function maybeLogBulkRepairSummaryWarning(repairedMessages, repairedMarkers) {
    if (getRepairToastMode() !== "all") return;
    if (repairedMarkers <= 0) return;

    console.warn("[ComfyInject] Repaired markers during bulk scan:", {
        repairedMessages,
        repairedMarkers,
    });
}

/**
 * Formats a marker position label within a message.
 * Only includes numbering when the message had multiple markers.
 * @param {number} markerNumber - 1-based marker number within the message
 * @param {number} totalMarkers - Total markers in the message
 * @returns {string}
 */
function formatMarkerPosition(markerNumber, totalMarkers) {
    return totalMarkers > 1 ? ` ${markerNumber}/${totalMarkers}` : "";
}

let activeStream = null;
const LIVE_STREAM_SCAN_INTERVAL_MS = 500;

// Tracks which message indices are currently being processed to prevent duplicate jobs.
const processingMessages = new Set();

// Incremented whenever the generation context is invalidated:
// new generation started, generation stopped/cancelled, or chat changed.
// processMessage() captures this at call time and discards results if it changed.
let activeGenerationId = 0;

/**
 * Bumps the generation ID, invalidating any in-progress processMessage results,
 * and clears the per-message processing guard so new calls are not blocked.
 */
function bumpGenerationId() {
    activeGenerationId++;
    processingMessages.clear();
}

/**
 * Resets live stream marker tracking for a new generation.
 */
function resetLiveStream() {
    stopLiveStreamScanner();

    activeStream = {
        text: "",
        jobs: new Map(),
        scanner: setInterval(startLiveMarkerGenerations, LIVE_STREAM_SCAN_INTERVAL_MS),
    };
}

/**
 * Stops the live stream scanner without discarding already-started jobs.
 */
function stopLiveStreamScanner() {
    if (!activeStream?.scanner) return;

    clearInterval(activeStream.scanner);
    activeStream.scanner = null;
}

/**
 * Clears all live stream state for the current generation.
 */
function clearLiveStream() {
    stopLiveStreamScanner();
    activeStream = null;
}

/**
 * Returns the best current message index to use while streaming.
 * During normal streaming ST has already created the live bot message.
 * @returns {number}
 */
function getLiveMessageIndex() {
    const context = SillyTavern.getContext();
    if (!Array.isArray(context.chat) || context.chat.length === 0) return 0;

    for (let i = context.chat.length - 1; i >= 0; i--) {
        if (!context.chat[i]?.is_user) return i;
    }

    return context.chat.length - 1;
}

/**
 * Builds a stable key for one marker occurrence within the streamed reply.
 * Marker order is more reliable than raw marker text because final message
 * formatting can differ slightly from the stream buffer.
 * @param {number} markerIndex
 * @returns {string}
 */
function getMarkerJobKey(markerIndex) {
    return String(markerIndex);
}

/**
 * Updates the stream buffer from ST's stream event payload.
 * Current ST sends the full generated text so far; this also tolerates
 * providers/extensions that emit incremental chunks.
 * @param {string} text
 */
function updateStreamText(text) {
    if (!activeStream) resetLiveStream();

    const incoming = String(text ?? "");
    if (!incoming) return;

    if (!activeStream.text || incoming.startsWith(activeStream.text)) {
        activeStream.text = incoming;
    } else {
        activeStream.text += incoming;
    }

    // Refresh the live display on every token when jobs are active so that
    // pending placeholders stay in sync with the streamed text as it grows.
    if (activeStream.jobs.size > 0) renderLiveStream();
}

/**
 * Starts ComfyUI jobs as soon as complete markers appear in streamed output.
 * Jobs are cached and consumed later by processMessage().
 */
function startLiveMarkerGenerations() {
    if (!activeStream?.text) return;

    const messageIndex = getLiveMessageIndex();
    const parsedMarkers = parseImageMarkers(activeStream.text, messageIndex);

    parsedMarkers.forEach((parsed, markerIndex) => {
        if (parsed.status !== "parsed") return;

        const key = getMarkerJobKey(markerIndex);
        if (activeStream.jobs.has(key)) return;

        const promise = generateParsedMarker(parsed, messageIndex);
        activeStream.jobs.set(key, { promise, result: null, used: false });

        promise.then(result => {
            const job = activeStream?.jobs.get(key);
            if (job) {
                job.result = result;
                renderLiveStream();
            }
        });

        console.log("[ComfyInject] Live marker detected, ComfyUI job started:", {
            messageIndex,
            markerNumber: markerIndex + 1,
        });
    });
}

/**
 * Returns a pre-started generation promise for a final rendered marker.
 * @param {object} parsed
 * @param {number} markerIndex
 * @returns {Promise<object>|null}
 */
function getLiveGeneration(parsed, markerIndex) {
    if (!activeStream?.jobs) return null;

    const key = getMarkerJobKey(markerIndex);
    const job = activeStream.jobs.get(key);
    if (!job || job.used) return null;

    job.used = true;
    console.log("[ComfyInject] Reusing live ComfyUI job:", {
        markerNumber: markerIndex + 1,
    });
    return job.promise;
}

/**
 * Re-renders the live streaming message with current job states.
 * Markers with completed jobs are replaced with images or error spans.
 * Markers with in-flight jobs are replaced with pending placeholder spans.
 *
 * Uses the borrow pattern: temporarily sets message.mes to the display text,
 * calls updateMessageBlock, then restores the original mes so ST can keep
 * appending tokens and processMessage sees the raw markers when the stream ends.
 */
function renderLiveStream() {
    if (!activeStream) return;

    const messageIndex = getLiveMessageIndex();
    const context = SillyTavern.getContext();
    const message = context.chat[messageIndex];
    if (!message || message.is_user) return;

    const { updateMessageBlock } = SillyTavern.getContext();

    // Count total markers in the current stream buffer for position labels.
    const totalMarkers = (activeStream.text.match(/\[\[IMG:\s*.+?\s*\]\]/gs) || []).length;
    if (totalMarkers === 0) return;

    // Replace each [[IMG:...]] with its current job state.
    let markerIdx = 0;
    const displayText = activeStream.text.replace(/\[\[IMG:\s*.+?\s*\]\]/gs, () => {
        const i = markerIdx++;
        const key = getMarkerJobKey(i);
        const job = activeStream?.jobs.get(key);
        const markerPosition = formatMarkerPosition(i + 1, totalMarkers);

        if (!job || job.result === null) {
            return `<span class="comfyinject-pending">[Generating image${markerPosition}...]</span>`;
        }

        const result = job.result;
        if (result?.status === "ok") {
            return buildImgTag(result.imageUrl, result.prompt, result.seed);
        }
        return `<span class="comfyinject-error">[Image generation failed${markerPosition ? `: marker${markerPosition}` : ""}]</span>`;
    });

    // Borrow: temporarily replace mes with the display text, render, restore.
    const savedMes = message.mes;
    message.mes = displayText;
    try { updateMessageBlock(messageIndex, message); } catch (_e) {}
    message.mes = savedMes;
}

/**
 * Adds retry buttons to all rendered comfyinject images in a message.
 * This is done via DOM manipulation (not in message.mes) because
 * ST's HTML sanitizer strips custom divs when rendering messages.
 * Each button stores send_date and imgindex for the retry handler.
 * @param {number} index - The current message array index (for DOM lookup via mesid)
 */
function addRetryButtons(index) {
    const context = SillyTavern.getContext();
    const message = context.chat[index];
    if (!message) return;

    const messageNode = document.querySelector(`[mesid="${index}"]`);
    if (!messageNode) return;

    // ST's sanitizer prefixes custom classes with "custom-" in the rendered DOM
    const images = messageNode.querySelectorAll(".custom-comfyinject-image");
    if (images.length === 0) return;

    const sendDate = message.send_date;

    images.forEach((img, imgIndex) => {
        // Don't add a second retry button if one already exists
        if (img.parentElement?.querySelector(".comfyinject-retry")) return;

        // Wrap the image in a relative container so we can position the button
        const wrapper = document.createElement("div");
        wrapper.className = "comfyinject-wrapper";
        wrapper.style.cssText = "position: relative; display: inline-block;";
        img.parentElement.insertBefore(wrapper, img);
        wrapper.appendChild(img);

        // Create the retry button
        const btn = document.createElement("div");
        btn.className = "comfyinject-retry";
        btn.dataset.senddate = sendDate;
        btn.dataset.imgindex = imgIndex;
        btn.title = "Regenerate with new seed";
        btn.style.cssText = "position: absolute; top: 6px; right: 6px; cursor: pointer; background: rgba(0,0,0,0.6); color: white; border-radius: 4px; padding: 2px 8px; font-size: 12px; z-index: 10;";
        btn.innerHTML = `<i class="fa-solid fa-rotate"></i>`;

        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            e.preventDefault();
            await retryImage(sendDate, imgIndex, btn);
        });

        wrapper.appendChild(btn);
    });
}

/**
 * Adds retry buttons to all rendered comfyinject images across the entire chat.
 * Called after scanning existing messages on chat load.
 */
function addAllRetryButtons() {
    const context = SillyTavern.getContext();
    for (let i = 0; i < context.chat.length; i++) {
        addRetryButtons(i);
    }
}

/**
 * Processes a single message by index.
 * If it contains [[IMG: ... ]] markers, generates the images sequentially,
 * injects <img> tags into both the DOM and the mes field,
 * saves metadata keyed by send_date, and calls saveChat().
 * @param {number} index - The message index in the chat array
 */
async function processMessage(index, options = {}) {
    const context = SillyTavern.getContext();
    const message = context.chat[index];
    const { updateMessageBlock } = SillyTavern.getContext();
    const { suppressRepairNotifications = false, checkGenerationId = false } = options;

    if (!message) return { repairedCount: 0, totalCount: 0 };

    // Only process bot messages
    if (message.is_user) return { repairedCount: 0, totalCount: 0 };

    // Skip if no marker present
    if (!hasImageMarker(message.mes)) return { repairedCount: 0, totalCount: 0 };

    // Prevent concurrent processing of the same message index.
    // A second call for the same index (e.g. duplicate CHARACTER_MESSAGE_RENDERED)
    // would start redundant ComfyUI jobs for markers that are already in flight.
    if (processingMessages.has(index)) {
        console.log(`[ComfyInject] Skipping duplicate processMessage for index ${index}`);
        return { repairedCount: 0, totalCount: 0 };
    }

    // Snapshot the current generation ID so we can detect cancellation or a new
    // generation starting while we are awaiting ComfyUI results.
    const capturedGenId = activeGenerationId;
    processingMessages.add(index);

    try {
        console.log(`[ComfyInject] Processing message ${index}`);

        const originalSendDate = message.send_date;
        const parsedMarkers = parseImageMarkers(message.mes, index);
        const markerCount = parsedMarkers.length;

        if (markerCount === 0) return { repairedCount: 0, totalCount: 0 };

        // Replace each [[IMG:...]] marker with an indexed placeholder.
        // Jobs can complete out of order, so each needs a unique handle to target.
        // The closing `"` in the class name bounds the index so idx-1 won't match idx-10.
        let pidx = 0;
        message.mes = message.mes.replace(/\[\[IMG:\s*.+?\s*\]\]/gs, () => {
            const i = pidx++;
            return `<span class="comfyinject-pending comfyinject-idx-${i}">[Generating image ${i + 1}/${markerCount}...]</span>`;
        });
        try { updateMessageBlock(index, message); } catch (_e) {}

        const useLiveGenerations = activeStream && index === getLiveMessageIndex();

        // Sparse results array — filled by handleJobResult as each job settles.
        const results = new Array(markerCount).fill(null);
        let repairedCount = 0;

        /**
         * Called synchronously when each job settles.
         * Replaces the matching indexed placeholder and immediately re-renders
         * so the user sees each image as soon as it is ready.
         * @param {object} result
         * @param {number} markerIndex
         */
        const handleJobResult = (result, markerIndex) => {
            // Drop the result if the generation was cancelled or superseded.
            if (checkGenerationId && capturedGenId !== activeGenerationId) return;

            const currentMessage = context.chat[index];
            if (!currentMessage || currentMessage.send_date !== originalSendDate) return;

            const markerNumber = markerIndex + 1;
            const markerPosition = formatMarkerPosition(markerNumber, markerCount);
            let replacement;

            if (result?.status === "ok") {
                if (hasMeaningfulRepair(result.repairMeta)) repairedCount++;
                results[markerIndex] = result;
                replacement = buildImgTag(result.imageUrl, result.prompt, result.seed);

            } else if (result?.status === "parse_error") {
                const reason = result?.reason;
                let errorText;
                switch (reason) {
                    case "empty_prompt": errorText = `[Image marker${markerPosition} invalid: empty prompt]`; break;
                    case "empty_marker": errorText = `[Image marker${markerPosition} invalid: empty marker]`; break;
                    default:             errorText = `[Image marker${markerPosition} invalid]`; break;
                }
                console.warn("[ComfyInject] Image marker parse failed:", {
                    reason, rawMarker: result?.rawMarker || null,
                    messageIndex: index, markerNumber, totalMarkers: markerCount,
                });
                if (!suppressRepairNotifications) maybeShowParseFailureToast(errorText);
                replacement = `<span class="comfyinject-error">${errorText}</span>`;

            } else if (result?.status === "generation_error") {
                const errorText = `[Image generation failed${markerPosition ? `: marker${markerPosition}` : ""}]`;
                console.error("[ComfyInject] Image generation failed:", {
                    messageIndex: index, markerNumber, totalMarkers: markerCount,
                });
                replacement = `<span class="comfyinject-error">${errorText}</span>`;

            } else {
                const errorText = `[Image generation failed${markerPosition ? `: marker${markerPosition}` : ""}]`;
                console.error("[ComfyInject] Unexpected marker result shape:", {
                    result, messageIndex: index, markerNumber, totalMarkers: markerCount,
                });
                replacement = `<span class="comfyinject-error">${errorText}</span>`;
            }

            // Target exactly the indexed placeholder — safe for out-of-order completion.
            currentMessage.mes = currentMessage.mes.replace(
                new RegExp(`<span[^>]*comfyinject-idx-${markerIndex}"[^>]*>[^<]*</span>`),
                replacement
            );
            try { updateMessageBlock(index, currentMessage); } catch (_e) {}
        };

        // Build one promise per marker.
        // Parse errors are handled synchronously; generation jobs call handleJobResult
        // as soon as ComfyUI responds, inserting the image without waiting for others.
        const jobPromises = parsedMarkers.map((parsed, markerIndex) => {
            if (parsed.status === "parse_error") {
                handleJobResult(parsed, markerIndex);
                return Promise.resolve();
            }

            const liveJob = useLiveGenerations ? getLiveGeneration(parsed, markerIndex) : null;
            const jobPromise = liveJob ?? generateParsedMarker(parsed, index);
            return jobPromise.then(result => handleJobResult(result, markerIndex));
        });

        if (useLiveGenerations) {
            clearLiveStream();
        }

        // Wait for all jobs to settle.  Each image was already inserted by handleJobResult.
        await Promise.all(jobPromises);

        // Post-await generation check — covers cancel / chat-change during the wait.
        if (checkGenerationId && capturedGenId !== activeGenerationId) {
            console.log(`[ComfyInject] Generation changed (${capturedGenId} → ${activeGenerationId}), cleaning up placeholders for message ${index}`);

            // Replace any placeholder spans that were never resolved (their jobs were
            // dropped by the cancellation check in handleJobResult).
            // We update in-memory only — no saveChat — so the original [[IMG:...]] markers
            // remain on disk and the user can retry by reloading or regenerating.
            const cancelledMessage = context.chat[index];
            if (cancelledMessage && cancelledMessage.send_date === originalSendDate) {
                const cleaned = cancelledMessage.mes.replace(
                    /<span[^>]*comfyinject-pending[^>]*>[^<]*<\/span>/g,
                    `<span class="comfyinject-error">[Image generation cancelled]</span>`
                );
                if (cleaned !== cancelledMessage.mes) {
                    cancelledMessage.mes = cleaned;
                    try { updateMessageBlock(index, cancelledMessage); } catch (_e) {}
                }
            }

            return { repairedCount: 0, totalCount: markerCount };
        }

        // Message integrity check — covers deletion or swipe during the wait.
        const currentMessage = context.chat[index];
        if (!currentMessage || currentMessage.send_date !== originalSendDate) {
            console.warn("[ComfyInject] Message removed or replaced during generation, discarding save:", {
                messageIndex: index, originalSendDate,
            });
            return { repairedCount: 0, totalCount: markerCount };
        }

        // Add retry buttons now that all images are in the DOM.
        addRetryButtons(index);

        // Persist metadata keyed by send_date (only successful results).
        if (!context.chatMetadata[MODULE_NAME]) {
            context.chatMetadata[MODULE_NAME] = {};
        }
        const metadataArray = results
            .filter(r => r?.status === "ok")
            .map(r => ({
                seed: r.seed, ar: r.ar, shot: r.shot,
                promptId: r.promptId, filename: r.filename,
                effectiveAr: r.effectiveAr, effectiveShot: r.effectiveShot,
                resolution: r.resolution, shotTags: r.shotTags,
                repairMeta: r.repairMeta,
            }));

        context.chatMetadata[MODULE_NAME][currentMessage.send_date] = metadataArray;
        await context.saveMetadata();
        await context.saveChat();

        if (!suppressRepairNotifications) {
            maybeShowGroupedRepairToast(repairedCount, markerCount);
            maybeLogGroupedRepairWarning(index, repairedCount, markerCount);
        }

        const successCount = results.filter(r => r?.status === "ok").length;
        console.log(`[ComfyInject] Message ${index} saved with ${successCount} injected image(s)`);

        return { repairedCount, totalCount: markerCount };
    } finally {
        processingMessages.delete(index);
    }
}

/**
 * Scans all existing messages in the current chat and processes
 * any that still have an unprocessed [[IMG: ... ]] marker.
 * Called on APP_READY and CHAT_CHANGED.
 */
async function scanExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return;

    console.log(`[ComfyInject] Scanning ${context.chat.length} existing messages`);

    let repairedMessages = 0;
    let repairedMarkers = 0;

    for (let i = 0; i < context.chat.length; i++) {
        const message = context.chat[i];
        if (!message.is_user && hasImageMarker(message.mes)) {
            const summary = await processMessage(i, { suppressRepairNotifications: true });

            if (summary?.repairedCount > 0) {
                repairedMessages++;
                repairedMarkers += summary.repairedCount;
            }
        }
    }

    maybeShowBulkRepairSummaryToast(repairedMessages, repairedMarkers);
    maybeLogBulkRepairSummaryWarning(repairedMessages, repairedMarkers);

    // Add retry buttons to all already-rendered images (including ones from previous sessions)
    addAllRetryButtons();
}

/**
 * Retries image generation for a specific image within a message with a new random seed.
 * Uses send_date to look up metadata (stable across deletions).
 * @param {string} sendDate - The send_date of the message to retry
 * @param {number} imgIndex - Which image within the message to retry (0-based)
 * @param {HTMLElement|null} retryBtn - The clicked retry button, if available
 */
async function retryImage(sendDate, imgIndex, retryBtn = null) {
    const context = SillyTavern.getContext();
    const { updateMessageBlock } = SillyTavern.getContext();

    if (!context.chatMetadata[MODULE_NAME]) {
        context.chatMetadata[MODULE_NAME] = {};
    }
    const metadata = context.chatMetadata[MODULE_NAME];

    // Find the current array index for this message
    const messageIndex = findIndexBySendDate(sendDate);
    if (messageIndex === -1) {
        console.warn("[ComfyInject] Retry skipped: message not found", { sendDate, imgIndex });
        return;
    }

    const message = context.chat[messageIndex];
    if (!message) {
        console.warn("[ComfyInject] Retry skipped: message missing", { messageIndex, imgIndex });
        return;
    }

    // Parse prompt from the img tag in mes (source of truth, not stored in metadata)
    const imgTags = [...message.mes.matchAll(/<img class="comfyinject-image"[^>]*>/g)];
    const targetTag = imgTags[imgIndex];
    if (!targetTag) {
        console.warn("[ComfyInject] Retry skipped: image tag not found", {
            messageIndex,
            imgIndex,
            imageCount: imgTags.length,
        });
        return;
    }

    const prompt = targetTag[0].match(/data-prompt="([^"]*)"/)?.[1]?.replace(/&quot;/g, '"') || "";
    if (!prompt) {
        console.warn("[ComfyInject] Retry skipped: image prompt missing", { messageIndex, imgIndex });
        return;
    }

    // Look up metadata for supplementary fields (ar, shot)
    const images = getImageData(metadata, sendDate).length > 0
        ? getImageData(metadata, sendDate)
        : getImageData(metadata, messageIndex);
    const imageData = images[imgIndex] || {};

    const { ar, shot } = imageData;

    // Fall back to the same marker-level defaults used by the parser
    // if metadata is missing or incomplete.
    const retryAr = ar || "SQUARE";
    const retryShot = shot || "MEDIUM";

    // Generate a new random seed using the shared project-wide max safe integer range.
    const newSeed = Math.floor(Math.random() * 9007199254740991);

    // Show generating state on the retry button
    if (retryBtn) {
        retryBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
        retryBtn.style.pointerEvents = "none";
    }

    let result;
    try {
        result = await generateImage({
            prompt,
            ar: retryAr,
            shot: retryShot,
            seed: newSeed,
            messageIndex,
            bypassSeedLock: true,
        });
    } catch (err) {
        console.error(`[ComfyInject] Retry failed for message ${messageIndex} image ${imgIndex}:`, err);
        toastr.error("Image retry failed.", "ComfyInject");
        // Restore retry button
        if (retryBtn) {
            retryBtn.innerHTML = `<i class="fa-solid fa-rotate"></i>`;
            retryBtn.style.pointerEvents = "auto";
        }
        return;
    }

    const { imageUrl, seed: effectiveSeed, promptId, filename, effectiveAr, effectiveShot, resolution, shotTags } = result;

    // Save the seed that was actually used so LOCK works
    saveLastSeed(effectiveSeed);

    // Update metadata — try send_date key first, fall back to index for legacy.
    // Guard against missing or malformed entries so retry does not recreate bad metadata.
    const metaKey = metadata[sendDate] ? sendDate : (metadata[messageIndex] ? messageIndex : sendDate);
    let metaEntry = metadata[metaKey];

    if (!metaEntry) {
        metaEntry = [];
        metadata[metaKey] = metaEntry;
    }

    if (Array.isArray(metaEntry)) {
        const existingEntry = metaEntry[imgIndex] && typeof metaEntry[imgIndex] === "object"
            ? metaEntry[imgIndex]
            : {};

        metaEntry[imgIndex] = {
            ...existingEntry,
            seed: effectiveSeed,
            ar: existingEntry.ar || retryAr,
            shot: existingEntry.shot || retryShot,
            promptId,
            filename,
            effectiveAr,
            effectiveShot,
            resolution,
            shotTags,
            repairMeta: existingEntry.repairMeta || null,
        };
    } else if (metaEntry && typeof metaEntry === "object") {
        metadata[metaKey] = {
            ...metaEntry,
            seed: effectiveSeed,
            ar: metaEntry.ar || retryAr,
            shot: metaEntry.shot || retryShot,
            promptId,
            filename,
            effectiveAr,
            effectiveShot,
            resolution,
            shotTags,
            repairMeta: metaEntry.repairMeta || null,
        };
    }

    // Replace the Nth img tag in mes (where N = imgIndex)
    const newImgTag = buildImgTag(imageUrl, prompt, effectiveSeed);
    let count = 0;
    message.mes = message.mes.replace(/<img class="comfyinject-image"[^>]*>/g, (match) => {
        if (count === imgIndex) {
            count++;
            return newImgTag;
        }
        count++;
        return match;
    });

    // Re-render
    try {
        updateMessageBlock(messageIndex, message);
    } catch (e) {
        // ST's reasoning handler may crash on some messages, that's okay
    }

    // Re-add retry buttons since updateMessageBlock wipes the DOM
    addRetryButtons(messageIndex);

    // Persist
    await context.saveMetadata();
    await context.saveChat();
}

/**
 * Registers all SillyTavern event listeners.
 * Called once from index.js on load.
 */
export function initDom() {
    const { eventSource, event_types } = SillyTavern.getContext();

    // Start watching streamed text as soon as a visible generation begins.
    eventSource.on(event_types.GENERATION_STARTED, (type, _params, isDryRun) => {
        if (type === "quiet" || isDryRun) {
            clearLiveStream();
            return;
        }

        // New generation supersedes any in-progress results from a previous one.
        bumpGenerationId();
        resetLiveStream();
    });

    // ST emits the current streamed text frequently. Keep this handler cheap;
    // the timer started in resetLiveStream() does marker scanning.
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, (text) => {
        updateStreamText(text);
    });

    eventSource.on(event_types.GENERATION_ENDED, stopLiveStreamScanner);

    // User cancelled — discard all in-progress jobs and live stream state.
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        bumpGenerationId();
        clearLiveStream();
    });

    // Process new bot messages as they are rendered.
    // checkGenerationId: true so cancellation/retry/new-generation discards results.
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (index) => {
        await processMessage(index, { checkGenerationId: true });
    });

    // Re-scan when chat changes — clear everything first so no stale jobs survive.
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        bumpGenerationId();
        clearLiveStream();
        await scanExistingMessages();
    });

    // Re-add retry buttons after swipes and edits since ST re-renders the message DOM
    const reAddRetryButtons = (index) => setTimeout(() => addRetryButtons(index), 100);
    eventSource.on(event_types.MESSAGE_SWIPED, reAddRetryButtons);
    eventSource.on(event_types.MESSAGE_UPDATED, reAddRetryButtons);
    eventSource.on(event_types.MESSAGE_EDITED, reAddRetryButtons);

    console.log("[ComfyInject] DOM listener initialized");
}

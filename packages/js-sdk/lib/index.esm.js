import { ConnectionQuality as ConnectionQuality$1, ParticipantEvent, RoomEvent, ConnectionState, Track, createLocalAudioTrack, TrackEvent, Room, VideoPresets, supportsDynacast, supportsAdaptiveStream } from 'livekit-client';
import { EventEmitter } from 'events';
import WebRTCIssueDetector from 'webrtc-issue-detector';

/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */
/* global Reflect, Promise, SuppressedError, Symbol, Iterator */


function __awaiter(thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
}

typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
};

var SessionEvent;
(function (SessionEvent) {
    SessionEvent["SESSION_STATE_CHANGED"] = "session.state_changed";
    SessionEvent["SESSION_STREAM_READY"] = "session.stream_ready";
    SessionEvent["SESSION_CONNECTION_QUALITY_CHANGED"] = "session.connection_quality_changed";
    SessionEvent["SESSION_DISCONNECTED"] = "session.disconnected";
})(SessionEvent || (SessionEvent = {}));
var AgentEventsEnum;
(function (AgentEventsEnum) {
    AgentEventsEnum["SESSION_UPDATED"] = "session.updated";
    AgentEventsEnum["SESSION_STATE_UPDATED"] = "session.state_updated";
    AgentEventsEnum["USER_SPEAK_STARTED"] = "user.speak_started";
    AgentEventsEnum["USER_SPEAK_ENDED"] = "user.speak_ended";
    AgentEventsEnum["USER_TRANSCRIPTION"] = "user.transcription";
    AgentEventsEnum["AVATAR_TRANSCRIPTION"] = "avatar.transcription";
    AgentEventsEnum["AVATAR_SPEAK_STARTED"] = "avatar.speak_started";
    AgentEventsEnum["AVATAR_SPEAK_ENDED"] = "avatar.speak_ended";
})(AgentEventsEnum || (AgentEventsEnum = {}));
const getAgentEventEmitArgs = (event) => {
    if ("event_type" in event) {
        switch (event.event_type) {
            case AgentEventsEnum.USER_SPEAK_STARTED: {
                const payload = {
                    event_id: event.event_id,
                    event_type: event.event_type,
                };
                return [AgentEventsEnum.USER_SPEAK_STARTED, payload];
            }
            case AgentEventsEnum.USER_SPEAK_ENDED: {
                const payload = {
                    event_id: event.event_id,
                    event_type: event.event_type,
                };
                return [AgentEventsEnum.USER_SPEAK_ENDED, payload];
            }
            case AgentEventsEnum.USER_TRANSCRIPTION: {
                const payload = {
                    event_id: event.event_id,
                    event_type: event.event_type,
                    text: event.text,
                };
                return [AgentEventsEnum.USER_TRANSCRIPTION, payload];
            }
            case AgentEventsEnum.AVATAR_SPEAK_STARTED: {
                const payload = {
                    event_id: event.event_id,
                    event_type: event.event_type,
                };
                return [AgentEventsEnum.AVATAR_SPEAK_STARTED, payload];
            }
            case AgentEventsEnum.AVATAR_SPEAK_ENDED: {
                const payload = {
                    event_id: event.event_id,
                    event_type: event.event_type,
                };
                return [AgentEventsEnum.AVATAR_SPEAK_ENDED, payload];
            }
            case AgentEventsEnum.AVATAR_TRANSCRIPTION: {
                const payload = {
                    event_id: event.event_id,
                    event_type: event.event_type,
                    text: event.text,
                };
                return [AgentEventsEnum.AVATAR_TRANSCRIPTION, payload];
            }
            default:
                console.warn("New unsupported event type");
                return null;
        }
    }
    return null;
};
var CommandEventsEnum;
(function (CommandEventsEnum) {
    CommandEventsEnum["SESSION_UPDATE"] = "session.update";
    CommandEventsEnum["SESSION_STOP"] = "session.stop";
    CommandEventsEnum["AVATAR_INTERRUPT"] = "avatar.interrupt";
    // AVATAR_INTERRUPT_VIDEO = "avatar.interrupt_video",
    CommandEventsEnum["AVATAR_SPEAK_TEXT"] = "avatar.speak_text";
    CommandEventsEnum["AVATAR_SPEAK_RESPONSE"] = "avatar.speak_response";
    CommandEventsEnum["AVATAR_SPEAK_AUDIO"] = "avatar.speak_audio";
    CommandEventsEnum["AVATAR_START_LISTENING"] = "avatar.start_listening";
    CommandEventsEnum["AVATAR_STOP_LISTENING"] = "avatar.stop_listening";
})(CommandEventsEnum || (CommandEventsEnum = {}));

var SessionState;
(function (SessionState) {
    SessionState["INACTIVE"] = "INACTIVE";
    SessionState["CONNECTING"] = "CONNECTING";
    SessionState["CONNECTED"] = "CONNECTED";
    SessionState["DISCONNECTING"] = "DISCONNECTING";
    SessionState["DISCONNECTED"] = "DISCONNECTED";
})(SessionState || (SessionState = {}));
var SessionDisconnectReason;
(function (SessionDisconnectReason) {
    SessionDisconnectReason["UNKNOWN_REASON"] = "UNKNOWN_REASON";
    SessionDisconnectReason["CLIENT_INITIATED"] = "CLIENT_INITIATED";
    SessionDisconnectReason["SESSION_START_FAILED"] = "SESSION_START_FAILED";
    // Consider adding other reasons: INACTIVITY_TIMEOUT, SESSION_DURATION_EXCEEDED, OUT_OF_CREDITS, etc.
})(SessionDisconnectReason || (SessionDisconnectReason = {}));
var Language;
(function (Language) {
    Language["af"] = "af";
    Language["sq"] = "sq";
    Language["am"] = "am";
    Language["ar"] = "ar";
    Language["hy"] = "hy";
    Language["as"] = "as";
    Language["ast"] = "ast";
    Language["az"] = "az";
    Language["ba"] = "ba";
    Language["eu"] = "eu";
    Language["be"] = "be";
    Language["bn"] = "bn";
    Language["bs"] = "bs";
    Language["br"] = "br";
    Language["bg"] = "bg";
    Language["my"] = "my";
    Language["ca"] = "ca";
    Language["ceb"] = "ceb";
    Language["zh"] = "zh";
    Language["hr"] = "hr";
    Language["cs"] = "cs";
    Language["da"] = "da";
    Language["nl"] = "nl";
    Language["en"] = "en";
    Language["et"] = "et";
    Language["fo"] = "fo";
    Language["fi"] = "fi";
    Language["fr"] = "fr";
    Language["fy"] = "fy";
    Language["ff"] = "ff";
    Language["gd"] = "gd";
    Language["gl"] = "gl";
    Language["lg"] = "lg";
    Language["ka"] = "ka";
    Language["de"] = "de";
    Language["el"] = "el";
    Language["gu"] = "gu";
    Language["ht"] = "ht";
    Language["ha"] = "ha";
    Language["haw"] = "haw";
    Language["he"] = "he";
    Language["hi"] = "hi";
    Language["hu"] = "hu";
    Language["is"] = "is";
    Language["ig"] = "ig";
    Language["ilo"] = "ilo";
    Language["id"] = "id";
    Language["ga"] = "ga";
    Language["it"] = "it";
    Language["ja"] = "ja";
    Language["jv"] = "jv";
    Language["kn"] = "kn";
    Language["kk"] = "kk";
    Language["km"] = "km";
    Language["ko"] = "ko";
    Language["lo"] = "lo";
    Language["la"] = "la";
    Language["lv"] = "lv";
    Language["lb"] = "lb";
    Language["ln"] = "ln";
    Language["lt"] = "lt";
    Language["mk"] = "mk";
    Language["mg"] = "mg";
    Language["ms"] = "ms";
    Language["ml"] = "ml";
    Language["mt"] = "mt";
    Language["mi"] = "mi";
    Language["mr"] = "mr";
    Language["mo"] = "mo";
    Language["mn"] = "mn";
    Language["ne"] = "ne";
    Language["no"] = "no";
    Language["nn"] = "nn";
    Language["oc"] = "oc";
    Language["or"] = "or";
    Language["pa"] = "pa";
    Language["ps"] = "ps";
    Language["fa"] = "fa";
    Language["pl"] = "pl";
    Language["pt"] = "pt";
    Language["ro"] = "ro";
    Language["ru"] = "ru";
    Language["sa"] = "sa";
    Language["sr"] = "sr";
    Language["sn"] = "sn";
    Language["sd"] = "sd";
    Language["si"] = "si";
    Language["sk"] = "sk";
    Language["sl"] = "sl";
    Language["so"] = "so";
    Language["es"] = "es";
    Language["su"] = "su";
    Language["sw"] = "sw";
    Language["ss"] = "ss";
    Language["sv"] = "sv";
    Language["tl"] = "tl";
    Language["tg"] = "tg";
    Language["ta"] = "ta";
    Language["tt"] = "tt";
    Language["te"] = "te";
    Language["th"] = "th";
    Language["bo"] = "bo";
    Language["tn"] = "tn";
    Language["tr"] = "tr";
    Language["tk"] = "tk";
    Language["uk"] = "uk";
    Language["ur"] = "ur";
    Language["uz"] = "uz";
    Language["vi"] = "vi";
    Language["cy"] = "cy";
    Language["wo"] = "wo";
    Language["xh"] = "xh";
    Language["yi"] = "yi";
    Language["yo"] = "yo";
    Language["zu"] = "zu";
})(Language || (Language = {}));

var ConnectionQuality;
(function (ConnectionQuality) {
    ConnectionQuality["UNKNOWN"] = "UNKNOWN";
    ConnectionQuality["GOOD"] = "GOOD";
    ConnectionQuality["BAD"] = "BAD";
})(ConnectionQuality || (ConnectionQuality = {}));

class AbstractConnectionQualityIndicator {
    constructor(onConnectionQualityChanged) {
        this._connectionQuality = ConnectionQuality.UNKNOWN;
        this.onConnectionQualityChanged = onConnectionQualityChanged;
    }
    get connectionQuality() {
        return this._connectionQuality;
    }
    handleStatsChanged() {
        const newConnectionQuality = this.calculateConnectionQuality();
        if (newConnectionQuality !== this._connectionQuality) {
            this._connectionQuality = newConnectionQuality;
            this.onConnectionQualityChanged(newConnectionQuality);
        }
    }
    start(params) {
        this.stop(true);
        this._start(params);
    }
    stop(muted = false) {
        this._stop();
        this._connectionQuality = ConnectionQuality.UNKNOWN;
        if (!muted) {
            this.onConnectionQualityChanged(ConnectionQuality.UNKNOWN);
        }
    }
}
function QualityIndicatorComposite(...configs) {
    class CombinedQualityIndicator extends AbstractConnectionQualityIndicator {
        constructor(onConnectionQualityChanged) {
            super(onConnectionQualityChanged);
            this.childTrackers = configs.map(({ getParams, TrackerClass }) => ({
                tracker: new TrackerClass(() => this.handleStatsChanged()),
                getParams,
            }));
        }
        calculateConnectionQuality() {
            const connectionQualities = this.childTrackers.map(({ tracker }) => tracker.connectionQuality);
            if (connectionQualities.some((quality) => quality === ConnectionQuality.BAD)) {
                return ConnectionQuality.BAD;
            }
            if (connectionQualities.every((quality) => quality === ConnectionQuality.UNKNOWN)) {
                return ConnectionQuality.UNKNOWN;
            }
            return ConnectionQuality.GOOD;
        }
        _start(params) {
            this.childTrackers.forEach(({ tracker, getParams }) => tracker.start(getParams(params)));
        }
        _stop() {
            this.childTrackers.forEach(({ tracker }) => tracker.stop(true));
        }
    }
    return CombinedQualityIndicator;
}

class LiveKitConnectionQualityIndicator extends AbstractConnectionQualityIndicator {
    constructor() {
        super(...arguments);
        this.room = null;
        this.liveKitConnectionQuality = ConnectionQuality$1.Unknown;
        this.liveKitConnectionState = null;
        this.handleConnectionQualityChanged = (quality) => {
            this.liveKitConnectionQuality = quality;
            this.handleStatsChanged();
        };
        this.handleConnectionStateChanged = (state) => {
            this.liveKitConnectionState = state;
            this.handleStatsChanged();
        };
    }
    _start(room) {
        this.room = room;
        this.room.localParticipant.on(ParticipantEvent.ConnectionQualityChanged, this.handleConnectionQualityChanged);
        this.room.on(RoomEvent.ConnectionStateChanged, this.handleConnectionStateChanged);
    }
    _stop() {
        if (this.room) {
            this.room.localParticipant.off(ParticipantEvent.ConnectionQualityChanged, this.handleConnectionQualityChanged);
            this.room.off(RoomEvent.ConnectionStateChanged, this.handleConnectionStateChanged);
        }
    }
    calculateConnectionQuality() {
        if ([ConnectionQuality$1.Lost, ConnectionQuality$1.Poor].includes(this.liveKitConnectionQuality)) {
            return ConnectionQuality.BAD;
        }
        if (this.liveKitConnectionState &&
            [
                ConnectionState.Disconnected,
                ConnectionState.Reconnecting,
                ConnectionState.SignalReconnecting,
            ].includes(this.liveKitConnectionState)) {
            return ConnectionQuality.BAD;
        }
        return ConnectionQuality.GOOD;
    }
}

class WebRTCConnectionQualityIndicator extends AbstractConnectionQualityIndicator {
    constructor() {
        super(...arguments);
        this.issueDetector = null;
        this.mosScores = null;
    }
    _start(peerConnection) {
        this.issueDetector = new WebRTCIssueDetector({
            autoAddPeerConnections: false,
            getStatsInterval: 3000,
            onNetworkScoresUpdated: (scores) => {
                this.mosScores = scores;
                this.handleStatsChanged();
            },
        });
        this.issueDetector.handleNewPeerConnection(peerConnection);
    }
    _stop() {
        if (this.issueDetector) {
            this.issueDetector.stopWatchingNewPeerConnections();
            this.issueDetector = null;
        }
        this.mosScores = null;
    }
    calculateConnectionQuality() {
        if (!this.mosScores ||
            (!this.mosScores.inbound && !this.mosScores.outbound)) {
            return ConnectionQuality.UNKNOWN;
        }
        if ((this.mosScores.inbound && this.mosScores.inbound < 3) ||
            (this.mosScores.outbound && this.mosScores.outbound < 3)) {
            return ConnectionQuality.BAD;
        }
        return ConnectionQuality.GOOD;
    }
}

const ConnectionQualityIndicator = QualityIndicatorComposite({
    TrackerClass: LiveKitConnectionQualityIndicator,
    getParams: (room) => room,
}, {
    TrackerClass: WebRTCConnectionQualityIndicator,
    getParams: (room) => { var _a; return ((_a = room.engine.pcManager) === null || _a === void 0 ? void 0 : _a.subscriber)._pc; },
});

var VoiceChatEvent;
(function (VoiceChatEvent) {
    VoiceChatEvent["MUTED"] = "MUTED";
    VoiceChatEvent["UNMUTED"] = "UNMUTED";
    // DEVICE_CHANGED = "DEVICE_CHANGED",
    VoiceChatEvent["STATE_CHANGED"] = "STATE_CHANGED";
    VoiceChatEvent["WARNING"] = "WARNING";
})(VoiceChatEvent || (VoiceChatEvent = {}));

var VoiceChatState;
(function (VoiceChatState) {
    VoiceChatState["INACTIVE"] = "INACTIVE";
    VoiceChatState["STARTING"] = "STARTING";
    VoiceChatState["ACTIVE"] = "ACTIVE";
})(VoiceChatState || (VoiceChatState = {}));

class VoiceChat extends EventEmitter {
    constructor(room) {
        super();
        this._state = VoiceChatState.INACTIVE;
        this.track = null;
        this.room = room;
    }
    get isConnected() {
        return (this.room.state !== ConnectionState.Disconnected &&
            this.room.state !== ConnectionState.Connecting);
    }
    get state() {
        return this._state;
    }
    get isMuted() {
        var _a, _b;
        return (_b = (_a = this.track) === null || _a === void 0 ? void 0 : _a.isMuted) !== null && _b !== void 0 ? _b : true;
    }
    start() {
        return __awaiter(this, arguments, void 0, function* (config = {}) {
            if (!this.isConnected) {
                console.warn("Voice chat can only be started when session is active");
                return;
            }
            if (this._state !== VoiceChatState.INACTIVE) {
                console.warn("Voice chat is already started");
                return;
            }
            this.state = VoiceChatState.STARTING;
            const { defaultMuted, deviceId } = config;
            try {
                this.track = yield createLocalAudioTrack({
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    deviceId,
                });
                if (defaultMuted) {
                    yield this.track.mute();
                    this.emit(VoiceChatEvent.MUTED);
                }
                else {
                    this.emit(VoiceChatEvent.UNMUTED);
                }
                yield this.room.localParticipant.publishTrack(this.track);
                this.track.on(TrackEvent.Muted, () => {
                    this.emit(VoiceChatEvent.MUTED);
                });
                this.track.on(TrackEvent.Unmuted, () => {
                    this.emit(VoiceChatEvent.UNMUTED);
                });
                this.state = VoiceChatState.ACTIVE;
            }
            catch (error) {
                // If microphone is not available, emit warning but don't fail
                const errorMessage = error instanceof Error ? error.message : String(error);
                const warningMessage = `Microphone not available: ${errorMessage}. Session will continue without voice chat.`;
                console.warn(warningMessage);
                this.emit(VoiceChatEvent.WARNING, warningMessage);
                this.state = VoiceChatState.INACTIVE;
            }
        });
    }
    stop() {
        this.room.localParticipant.getTrackPublications().forEach((publication) => {
            if (publication.track && publication.track.kind === Track.Kind.Audio) {
                publication.track.stop();
            }
        });
        if (this.track) {
            this.track.removeAllListeners();
            this.track.stop();
            this.track = null;
        }
        this.state = VoiceChatState.INACTIVE;
    }
    mute() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.state !== VoiceChatState.ACTIVE) {
                console.warn("Voice chat can only be muted when active");
                return;
            }
            if (this.track) {
                this.track.mute();
            }
        });
    }
    unmute() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.state !== VoiceChatState.ACTIVE) {
                console.warn("Voice chat can only be unmuted when active");
                return;
            }
            if (this.track) {
                this.track.unmute();
            }
        });
    }
    setDevice(deviceId) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.state !== VoiceChatState.ACTIVE) {
                console.warn("Voice chat device can only be set when active");
                return false;
            }
            if (this.track) {
                return this.track.setDeviceId(deviceId);
            }
            return false;
        });
    }
    set state(state) {
        if (this._state !== state) {
            this._state = state;
            this.emit(VoiceChatEvent.STATE_CHANGED, state);
        }
    }
}

const LIVEKIT_COMMAND_CHANNEL_TOPIC = "agent-control";
const LIVEKIT_SERVER_RESPONSE_CHANNEL_TOPIC = "agent-response";

const API_URL = "https://api.liveavatar.com";

const DEFAULT_ERROR_CODE = 500;
const SUCCESS_CODE = 1000;
class SessionApiError extends Error {
    constructor(message, errorCode, status) {
        super(message);
        this.status = null;
        this.errorCode = errorCode !== null && errorCode !== void 0 ? errorCode : DEFAULT_ERROR_CODE;
        this.status = status !== null && status !== void 0 ? status : null;
    }
}
class SessionAPIClient {
    constructor(sessionToken, apiUrl = API_URL) {
        this.sessionToken = sessionToken;
        this.apiUrl = apiUrl !== null && apiUrl !== void 0 ? apiUrl : API_URL;
    }
    request(path, params) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f;
            try {
                const response = yield fetch(`${this.apiUrl}${path}`, Object.assign(Object.assign({}, params), { credentials: "include", headers: Object.assign({ Authorization: `Bearer ${this.sessionToken}`, "Content-Type": "application/json" }, params.headers) }));
                if (!response.ok) {
                    const data = yield response.json();
                    const message = (_c = (_b = (_a = data.data) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : data.message) !== null && _c !== void 0 ? _c : `API request failed with status ${response.status}`;
                    throw new SessionApiError(message, data.code, response.status);
                }
                const data = yield response.json();
                if (data.code !== SUCCESS_CODE) {
                    const message = (_f = (_e = (_d = data.data) === null || _d === void 0 ? void 0 : _d.message) !== null && _e !== void 0 ? _e : data.message) !== null && _f !== void 0 ? _f : "API request failed";
                    throw new SessionApiError(message);
                }
                return data.data;
            }
            catch (err) {
                if (err instanceof SessionApiError) {
                    throw err;
                }
                throw new SessionApiError("API request failed");
            }
        });
    }
    startSession() {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.request(`/v1/sessions/start`, { method: "POST" });
        });
    }
    stopSession() {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.request(`/v1/sessions/stop`, { method: "POST" });
        });
    }
    keepAlive() {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.request(`/v1/sessions/keep-alive`, { method: "POST" });
        });
    }
}

/**
 * Splits a PCM 24KHz audio string (raw 16-bit signed PCM) into 20ms chunks.
 * @param pcmString - The raw PCM data as a string
 * @returns string[] - Array of 20ms PCM chunks as strings
 *
 * Each 20ms chunk at 24,000Hz, 16-bit mono = 24,000 * 0.02 = 480 samples.
 * Each sample = 2 bytes (16-bit), so 480 * 2 = 960 bytes per chunk.
 * Each JS string char is a single byte if encoded as binary string.
 */
function splitPcm24kStringToChunks(pcmString) {
    const bytesPerChunk = 480 * 2; // 960 bytes == 20ms at 24kHz mono, 16-bit
    const totalLength = pcmString.length;
    const result = [];
    for (let i = 0; i < totalLength; i += bytesPerChunk) {
        result.push(pcmString.slice(i, i + bytesPerChunk));
    }
    return result;
}

const HEYGEN_PARTICIPANT_ID = "heygen";
class LiveAvatarSession extends EventEmitter {
    constructor(sessionAccessToken, config) {
        super();
        this.connectionQualityIndicator = new ConnectionQualityIndicator((quality) => this.emit(SessionEvent.SESSION_CONNECTION_QUALITY_CHANGED, quality));
        this._sessionInfo = null;
        this._sessionEventSocket = null;
        this._state = SessionState.INACTIVE;
        this._remoteAudioTrack = null;
        this._remoteVideoTrack = null;
        // Required to construct the room
        this.config = config !== null && config !== void 0 ? config : {};
        this.sessionClient = new SessionAPIClient(sessionAccessToken, this.config.apiUrl);
        this.room = new Room({
            adaptiveStream: supportsAdaptiveStream()
                ? {
                    pauseVideoInBackground: false,
                }
                : false,
            dynacast: supportsDynacast(),
            videoCaptureDefaults: {
                resolution: VideoPresets.h720.resolution,
            },
        });
        this._voiceChat = new VoiceChat(this.room);
    }
    get state() {
        return this._state;
    }
    get connectionQuality() {
        return this.connectionQualityIndicator.connectionQuality;
    }
    get voiceChat() {
        return this._voiceChat;
    }
    get maxSessionDuration() {
        var _a, _b;
        return (_b = (_a = this._sessionInfo) === null || _a === void 0 ? void 0 : _a.max_session_duration) !== null && _b !== void 0 ? _b : null;
    }
    /** LiveAvatar server session id (available after {@link start} resolves). */
    get sessionId() {
        var _a, _b;
        return (_b = (_a = this._sessionInfo) === null || _a === void 0 ? void 0 : _a.session_id) !== null && _b !== void 0 ? _b : null;
    }
    start() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.state !== SessionState.INACTIVE) {
                console.warn("Session is already started");
                return;
            }
            try {
                this.state = SessionState.CONNECTING;
                this._sessionInfo = yield this.sessionClient.startSession();
                const livekitRoomUrl = this._sessionInfo.livekit_url;
                const livekitClientToken = this._sessionInfo.livekit_client_token;
                const websocketUrl = this._sessionInfo.ws_url;
                // Connect to LiveKit room if provided
                if (livekitRoomUrl && livekitClientToken) {
                    // Track the different events from the room, server, and websocket
                    this.trackEvents();
                    yield this.room.connect(livekitRoomUrl, livekitClientToken);
                    this.connectionQualityIndicator.start(this.room);
                }
                // Connect to WebSocket if provided
                if (websocketUrl) {
                    yield this.connectWebSocket(websocketUrl);
                    this.setupWebSocketManagement();
                }
                // Run configurations as needed
                yield this.configureSession();
                this.state = SessionState.CONNECTED;
            }
            catch (error) {
                console.error("Session start failed:", error);
                this.cleanup();
                this.postStop(SessionDisconnectReason.SESSION_START_FAILED);
                throw error;
            }
        });
    }
    stop() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.assertConnected()) {
                return;
            }
            this.state = SessionState.DISCONNECTING;
            this.cleanup();
            this.postStop(SessionDisconnectReason.CLIENT_INITIATED);
        });
    }
    keepAlive() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.assertConnected()) {
                return;
            }
            try {
                this.sessionClient.keepAlive();
            }
            catch (error) {
                console.error("Session keep alive error on server:", error);
                throw error;
            }
        });
    }
    attach(element) {
        if (!this._remoteVideoTrack || !this._remoteAudioTrack) {
            console.warn("Stream is not yet ready");
            return;
        }
        this._remoteVideoTrack.attach(element);
        this._remoteAudioTrack.attach(element);
    }
    message(message) {
        if (!this.assertConnected()) {
            return;
        }
        const data = {
            event_type: CommandEventsEnum.AVATAR_SPEAK_RESPONSE,
            text: message,
        };
        this.sendCommandEvent(data);
    }
    repeat(message) {
        if (!this.assertConnected()) {
            return;
        }
        const data = {
            event_type: CommandEventsEnum.AVATAR_SPEAK_TEXT,
            text: message,
        };
        this.sendCommandEvent(data);
    }
    repeatAudio(audio) {
        if (!this.assertConnected()) {
            return;
        }
        if (!this._sessionEventSocket) {
            console.warn("Cannot repeat audio. Please check you're using a supported mode.");
            return;
        }
        const data = {
            event_type: CommandEventsEnum.AVATAR_SPEAK_AUDIO,
            audio: audio,
        };
        this.sendCommandEvent(data);
    }
    startListening() {
        if (!this.assertConnected()) {
            return;
        }
        const data = {
            event_type: CommandEventsEnum.AVATAR_START_LISTENING,
        };
        this.sendCommandEvent(data);
    }
    stopListening() {
        if (!this.assertConnected()) {
            return;
        }
        const data = {
            event_type: CommandEventsEnum.AVATAR_STOP_LISTENING,
        };
        this.sendCommandEvent(data);
    }
    interrupt() {
        if (!this.assertConnected()) {
            return;
        }
        const data = {
            event_type: CommandEventsEnum.AVATAR_INTERRUPT,
        };
        this.sendCommandEvent(data);
    }
    trackEvents() {
        const mediaStream = new MediaStream();
        this.room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
            // We need to actively track the HeyGen participant's tracks
            if (participant.identity !== HEYGEN_PARTICIPANT_ID) {
                return;
            }
            if (track.kind === "video" || track.kind === "audio") {
                if (track.kind === "video") {
                    this._remoteVideoTrack = track;
                }
                else {
                    this._remoteAudioTrack = track;
                }
                mediaStream.addTrack(track.mediaStreamTrack);
                const hasVideoTrack = mediaStream.getVideoTracks().length > 0;
                const hasAudioTrack = mediaStream.getAudioTracks().length > 0;
                if (hasVideoTrack && hasAudioTrack) {
                    this.emit(SessionEvent.SESSION_STREAM_READY);
                }
            }
        });
        this.room.on(RoomEvent.DataReceived, (roomMessage, _, __, topic) => {
            if (topic !== LIVEKIT_SERVER_RESPONSE_CHANNEL_TOPIC) {
                return;
            }
            let eventMsg = null;
            try {
                const messageString = new TextDecoder().decode(roomMessage);
                eventMsg = JSON.parse(messageString);
            }
            catch (e) {
                console.error(e);
            }
            if (!eventMsg) {
                return;
            }
            const emitArgs = getAgentEventEmitArgs(eventMsg);
            if (emitArgs) {
                const [event_type, ...event_data] = emitArgs;
                this.emit(event_type, ...event_data);
            }
        });
        this.room.on(RoomEvent.ParticipantConnected, (participant) => {
            console.warn("participantConnected", participant);
        });
        this.room.on(RoomEvent.TrackUnsubscribed, (track) => {
            console.warn("trackUnsubscribed", track);
            const mediaTrack = track.mediaStreamTrack;
            if (mediaTrack) {
                mediaStream.removeTrack(mediaTrack);
            }
        });
        this.room.on(RoomEvent.Disconnected, () => {
            this.handleRoomDisconnect();
        });
    }
    connectWebSocket(websocketUrl) {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, _reject) => {
                this._sessionEventSocket = new WebSocket(websocketUrl);
                this._sessionEventSocket.onopen = () => {
                    resolve();
                };
            });
        });
    }
    setupWebSocketManagement() {
        if (!this._sessionEventSocket) {
            return;
        }
        this._sessionEventSocket.onmessage = (event) => {
            this.handleWebSocketMessage(event);
        };
        this._sessionEventSocket.onerror = (error) => {
            console.error("WebSocket error:", error);
        };
        this._sessionEventSocket.onclose = (event) => {
            console.warn("WebSocket closed - code:", event.code, "reason:", event.reason, "wasClean:", event.wasClean);
            this.handleWebSocketDisconnect();
        };
    }
    handleWebSocketMessage(event) {
        let eventData = null;
        try {
            eventData = JSON.parse(event.data);
        }
        catch (e) {
            console.error("Failed to parse WebSocket message:", e);
            return;
        }
        if (!eventData) {
            return;
        }
        const { type, event_id } = eventData;
        if (type === "agent.speak_started") {
            this.emit(AgentEventsEnum.AVATAR_SPEAK_STARTED, {
                event_type: AgentEventsEnum.AVATAR_SPEAK_STARTED,
                event_id: event_id,
            });
        }
        else if (type === "agent.speak_ended") {
            this.emit(AgentEventsEnum.AVATAR_SPEAK_ENDED, {
                event_type: AgentEventsEnum.AVATAR_SPEAK_ENDED,
                event_id: event_id,
            });
        }
    }
    handleWebSocketDisconnect() {
        if (this.state === SessionState.DISCONNECTING ||
            this.state === SessionState.DISCONNECTED) {
            return;
        }
        if (this._sessionEventSocket &&
            this._sessionEventSocket.readyState === WebSocket.OPEN) {
            this._sessionEventSocket.close();
        }
        this._sessionEventSocket = null;
        this.cleanup();
        this.postStop(SessionDisconnectReason.UNKNOWN_REASON);
    }
    configureSession() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.config.voiceChat) {
                yield this.voiceChat.start(typeof this.config.voiceChat === "boolean" ? {} : this.config.voiceChat);
            }
        });
    }
    set state(state) {
        if (this._state === state) {
            return;
        }
        this._state = state;
        this.emit(SessionEvent.SESSION_STATE_CHANGED, state);
    }
    cleanup() {
        return __awaiter(this, void 0, void 0, function* () {
            this.connectionQualityIndicator.stop();
            this.voiceChat.stop();
            if (this._remoteAudioTrack) {
                this._remoteAudioTrack.stop();
            }
            if (this._remoteVideoTrack) {
                this._remoteVideoTrack.stop();
            }
            this._remoteAudioTrack = null;
            this._remoteVideoTrack = null;
            this.room.localParticipant.removeAllListeners();
            this.room.removeAllListeners();
            // Clean up WebSocket
            if (this._sessionEventSocket) {
                // Remove event listeners to prevent callbacks during cleanup
                this._sessionEventSocket.onopen = null;
                this._sessionEventSocket.onmessage = null;
                this._sessionEventSocket.onerror = null;
                this._sessionEventSocket.onclose = null;
                if (this._sessionEventSocket.readyState === WebSocket.OPEN ||
                    this._sessionEventSocket.readyState === WebSocket.CONNECTING) {
                    this._sessionEventSocket.close();
                }
                this._sessionEventSocket = null;
            }
            // Disconnect from room if connected
            if (this.room.state === "connected") {
                this.room.disconnect();
            }
            // Kill the session on the server
            yield this.sessionClient.stopSession();
        });
    }
    postStop(reason) {
        this.state = SessionState.DISCONNECTED;
        this.emit(SessionEvent.SESSION_DISCONNECTED, reason);
    }
    handleRoomDisconnect() {
        this.cleanup();
        this.postStop(SessionDisconnectReason.UNKNOWN_REASON);
    }
    sendCommandEvent(commandEvent) {
        const hasOpenWebSocket = this._sessionEventSocket !== null &&
            this._sessionEventSocket.readyState === WebSocket.OPEN;
        const hasLiveKitRoom = this.room.state === "connected";
        // AVATAR_SPEAK_AUDIO is a LITE/custom-audio command and only travels over WebSocket.
        if (commandEvent.event_type === CommandEventsEnum.AVATAR_SPEAK_AUDIO) {
            if (hasOpenWebSocket) {
                console.info("[liveavatar-sdk] route=audio-ws", commandEvent.event_type);
                this.sendCommandEventToWebSocket(commandEvent);
            }
            else {
                console.warn("AVATAR_SPEAK_AUDIO requires an open WebSocket (LITE/custom-audio mode)");
            }
            return;
        }
        // FULL-mode commands (speak_text, speak_response, interrupt, listening lifecycle,
        // session.update/stop) must go on the LiveKit data channel topic `agent-control`.
        // Routing them through WebSocket silently drops them because the WS handler
        // does not implement those event types.
        if (hasLiveKitRoom) {
            console.info("[liveavatar-sdk] route=full-livekit", commandEvent.event_type, { hasOpenWebSocket, topic: LIVEKIT_COMMAND_CHANNEL_TOPIC });
            const data = new TextEncoder().encode(JSON.stringify(commandEvent));
            this.room.localParticipant.publishData(data, {
                reliable: true,
                topic: LIVEKIT_COMMAND_CHANNEL_TOPIC,
            });
            return;
        }
        // LITE-only fallback: no LiveKit room, fall back to WebSocket if it can carry the event.
        if (hasOpenWebSocket) {
            console.info("[liveavatar-sdk] route=lite-fallback-ws", commandEvent.event_type);
            this.sendCommandEventToWebSocket(commandEvent);
            return;
        }
        console.warn("[liveavatar-sdk] route=NO-CONNECTION", commandEvent.event_type);
    }
    generateEventId() {
        // Use native browser crypto API
        if (typeof crypto !== "undefined" && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        // Fallback for older browsers
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }
    sendCommandEventToWebSocket(commandEvent) {
        if (!this._sessionEventSocket ||
            this._sessionEventSocket.readyState !== WebSocket.OPEN) {
            console.warn("WebSocket not open to send command event");
            return;
        }
        const event_type = commandEvent.event_type;
        const event_id = this.generateEventId();
        let audioChunks = [];
        switch (event_type) {
            case CommandEventsEnum.AVATAR_SPEAK_AUDIO:
                audioChunks = splitPcm24kStringToChunks(commandEvent.audio);
                for (const audioChunk of audioChunks) {
                    this._sessionEventSocket.send(JSON.stringify({
                        type: "agent.speak",
                        event_id: event_id,
                        audio: audioChunk,
                    }));
                }
                this._sessionEventSocket.send(JSON.stringify({
                    type: "agent.speak_end",
                    event_id: event_id,
                }));
                return;
            case CommandEventsEnum.AVATAR_INTERRUPT:
                this._sessionEventSocket.send(JSON.stringify({
                    type: "agent.interrupt",
                    event_id: event_id,
                }));
                return;
            case CommandEventsEnum.AVATAR_START_LISTENING:
                this._sessionEventSocket.send(JSON.stringify({
                    type: "agent.start_listening",
                    event_id: event_id,
                }));
                return;
            case CommandEventsEnum.AVATAR_STOP_LISTENING:
                this._sessionEventSocket.send(JSON.stringify({
                    type: "agent.stop_listening",
                    event_id: event_id,
                }));
                return;
            default:
                console.warn("Unsupported command event type:", event_type);
                break;
        }
    }
    assertConnected() {
        if (this.state !== SessionState.CONNECTED) {
            console.warn("Session is not connected");
            return false;
        }
        return true;
    }
}

export { AgentEventsEnum, CommandEventsEnum, ConnectionQuality, Language, LiveAvatarSession, SessionDisconnectReason, SessionEvent, SessionState, VoiceChatEvent, VoiceChatState };

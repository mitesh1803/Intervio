import { BACKEND_URL } from "@/lib/config";
import axios from "axios";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Bot, Loader2, PhoneOff, User } from "lucide-react";
import { Button } from "./ui/button";
import { VoiceOrb } from "./VoiceOrb";

type Status = "connecting" | "live" | "ending";

function createLevelMeter(ctx: AudioContext, stream: MediaStream) {
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    return () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            const v = (data[i]! - 128) / 128;
            sum += v * v;
        }
        return Math.min(1, Math.sqrt(sum / data.length) * 3.2);
    };
}

export function Interview() {
    const { interviewId } = useParams();
    const navigate = useNavigate();

    const [status, setStatus] = useState<Status>("connecting");
    const [aiLevel, setAiLevel] = useState(0);
    const [userLevel, setUserLevel] = useState(0);

    const recorderRef = useRef<MediaRecorder | null>(null);
    const userStreamRef = useRef<MediaStream | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const rafRef = useRef<number | null>(null);
    const wsRef = useRef<WebSocket | null>(null);

    // TTS audio queue — plays sentences sequentially, no overlap
    const audioQueueRef = useRef<AudioBuffer[]>([]);
    const isPlayingRef = useRef(false);
    const aiLevelRef = useRef(0);

    function playNext(audioCtx: AudioContext) {
        if (audioQueueRef.current.length === 0) {
            isPlayingRef.current = false;
            aiLevelRef.current = 0;
            return;
        }
        isPlayingRef.current = true;
        const buffer = audioQueueRef.current.shift()!;

        // Wire level meter for AI audio
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.8;
        source.connect(analyser);
        analyser.connect(audioCtx.destination);

        const data = new Uint8Array(analyser.fftSize);
        const measureLevel = () => {
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
                const v = (data[i]! - 128) / 128;
                sum += v * v;
            }
            aiLevelRef.current = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
        };

        // Keep measuring level while this buffer plays
        const levelInterval = setInterval(measureLevel, 50);

        source.onended = () => {
            clearInterval(levelInterval);
            aiLevelRef.current = 0;
            playNext(audioCtx);
        };

        source.start();
    }

    async function enqueueAudio(arrayBuffer: ArrayBuffer, audioCtx: AudioContext) {
        try {
            const decoded = await audioCtx.decodeAudioData(arrayBuffer);
            audioQueueRef.current.push(decoded);
            if (!isPlayingRef.current) {
                playNext(audioCtx);
            }
        } catch (err) {
            console.error("[tts] decodeAudioData failed:", err);
        }
    }

    useEffect(() => {
        let cancelled = false;
        // We need a stable reference to audioCtx for the ws.onmessage closure
        let audioCtx: AudioContext;

        (async () => {
            try {
                await axios.post(`${BACKEND_URL}/api/v1/session/start/${interviewId}`);

                const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
                if (cancelled) { ms.getTracks().forEach(t => t.stop()); return; }

                audioCtx = new AudioContext();
                audioCtxRef.current = audioCtx;

                const userMeter = createLevelMeter(audioCtx, ms);

                // Connect to backend WebSocket
                const ws = new WebSocket(
                    `ws://localhost:3001/ws/interview?interviewId=${interviewId}`
                );
                wsRef.current = ws;

                ws.binaryType = "arraybuffer"; // important — receive audio as ArrayBuffer not Blob

                ws.onopen = () => {
                    console.log("[frontend] ws connected");

                    const recorder = new MediaRecorder(ms, { mimeType: "audio/webm" });
                    recorderRef.current = recorder;
                    recorder.start(250);

                    recorder.addEventListener("dataavailable", (e) => {
                        if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
                    });

                    setStatus("live");
                };

                ws.onmessage = async (event) => {
                    // Binary frame = TTS audio
                    if (event.data instanceof ArrayBuffer) {
                        console.log("[tts] received audio frame", event.data.byteLength, "bytes");
                        await enqueueAudio(event.data, audioCtx);
                        return;
                    }

                    // Text frame = JSON control message
                    const msg = JSON.parse(event.data as string);

                    if (msg.type === "transcript") {
                        console.log("[frontend] user said:", msg.transcript);
                    } else if (msg.type === "ai_chunk") {
                        // Optionally render streaming AI text in UI
                        console.log("[frontend] ai chunk:", msg.chunk);
                    } else if (msg.type === "tts_start") {
                        console.log("[frontend] tts sentence incoming");
                    } else if (msg.type === "tts_end") {
                        console.log("[frontend] tts sentence received");
                    }
                };

                ws.onerror = (e) => console.error("[frontend] ws error", e);
                ws.onclose = () => console.log("[frontend] ws closed");

                userStreamRef.current = ms;

                // Animation loop — update both volume meters
                const tick = () => {
                    setUserLevel(userMeter());
                    setAiLevel(aiLevelRef.current);
                    rafRef.current = requestAnimationFrame(tick);
                };
                rafRef.current = requestAnimationFrame(tick);

            } catch (err) {
                console.error("[interview] setup failed:", err);
            }
        })();

        return () => {
            cancelled = true;
            cleanup();
        };
    }, [interviewId]);

    function cleanup() {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        recorderRef.current?.state !== "inactive" && recorderRef.current?.stop();
        wsRef.current?.close();
        userStreamRef.current?.getTracks().forEach(t => t.stop());
        audioCtxRef.current?.close().catch(() => {});
        audioQueueRef.current = [];
        isPlayingRef.current = false;
    }

    function endInterview() {
        setStatus("ending");
        cleanup();
        navigate(`/result/${interviewId}`);
    }

    const aiSpeaking = aiLevel > 0.06 && aiLevel >= userLevel;
    const userSpeaking = userLevel > 0.06 && userLevel > aiLevel;

    return (
        <main className="flex h-screen w-screen flex-col overflow-hidden">
            <header className="flex items-center justify-between px-6 py-5">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="relative flex size-2.5">
                        <span className={
                            status === "live"
                                ? "absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"
                                : "hidden"
                        } />
                        <span className={
                            "relative inline-flex size-2.5 rounded-full " +
                            (status === "live" ? "bg-emerald-400" : "bg-amber-400")
                        } />
                    </span>
                    {status === "connecting" ? "Connecting…" : status === "ending" ? "Wrapping up…" : "Interview live"}
                </div>
                <span className="text-sm text-muted-foreground">AI Interview</span>
            </header>

            <div className="flex flex-1 items-center justify-center px-6">
                {status === "connecting" ? (
                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                        <Loader2 className="size-7 animate-spin" />
                        <p className="text-sm">Setting up your interview & microphone…</p>
                    </div>
                ) : (
                    <div className="flex w-full max-w-3xl items-center justify-center gap-12 sm:gap-24">
                        <VoiceOrb
                            level={aiLevel}
                            speaking={aiSpeaking}
                            label="Interviewer"
                            sublabel="Listening"
                            icon={Bot}
                            accent="violet"
                        />
                        <VoiceOrb
                            level={userLevel}
                            speaking={userSpeaking}
                            label="You"
                            sublabel="Mic on"
                            icon={User}
                            accent="emerald"
                        />
                    </div>
                )}
            </div>

            <footer className="flex justify-center px-6 py-8">
                <Button
                    variant="destructive"
                    size="lg"
                    onClick={endInterview}
                    disabled={status === "ending"}
                    className="gap-2 rounded-full px-6"
                >
                    {status === "ending" ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <PhoneOff className="size-4" />
                    )}
                    End interview
                </Button>
            </footer>
        </main>
    );
}

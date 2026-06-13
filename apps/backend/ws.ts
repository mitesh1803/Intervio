import { WebSocketServer, WebSocket } from "ws";
import { prisma } from "./db";
import { randomUUID } from "crypto";
import { redis } from "./src/lib/redis";
import { generateResponse } from "./llm";
import { synthesizeSentence } from "./tts";

export function setupWebSocket(server: any) {
    const wss = new WebSocketServer({ server, path: "/ws/interview" });

    wss.on("connection", async (clientSocket, req) => {
        console.log("[ws] frontend connected");
        const sessionId = randomUUID();

        await redis.set(
            `session:${sessionId}`,
            JSON.stringify({
                sessionId,
                aiSpeaking: false,
                currentQuestion: null,
                createdAt: Date.now(),
            })
        );

        const url = new URL(req.url!, "http://localhost");
        const interviewId = url.searchParams.get("interviewId");

        if (!interviewId) { clientSocket.close(); return; }

        // Fetch interview and extract githubData once at connection time
        const interview = await prisma.interview.findFirst({ where: { id: interviewId } });
        if (!interview) {
            console.error("[ws] interview not found:", interviewId);
            clientSocket.close();
            return;
        }
        const githubData = JSON.stringify(interview.githubMetadata);

        // --- helpers to flip aiSpeaking flag in Redis ---
        async function setAiSpeaking(val: boolean) {
            const raw = await redis.get(`session:${sessionId}`);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            parsed.aiSpeaking = val;
            await redis.set(`session:${sessionId}`, JSON.stringify(parsed));
        }

        // Buffer chunks that arrive before Deepgram STT is ready
        const earlyBuffer: Buffer[] = [];

        const dgSocket = new WebSocket(
            "wss://api.deepgram.com/v1/listen?punctuate=true&interim_results=true&endpointing=300",
            { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } }
        );

        dgSocket.on("open", () => {
            console.log("[deepgram] connected, replaying", earlyBuffer.length, "buffered chunks");
            for (const chunk of earlyBuffer) dgSocket.send(chunk);
            earlyBuffer.length = 0;
        });

        // Forward mic audio to Deepgram STT
        clientSocket.on("message", (audioChunk) => {
            if (dgSocket.readyState === WebSocket.OPEN) {
                dgSocket.send(audioChunk);
            } else {
                earlyBuffer.push(audioChunk as Buffer);
            }
        });

        // Handle Deepgram STT transcripts
        dgSocket.on("message", async (message) => {
            const data = JSON.parse(message.toString());
            const transcript = data.channel?.alternatives?.[0]?.transcript;
            const isFinal = data.is_final;

            if (!transcript || !isFinal) return;

            // Skip transcription if AI is currently speaking (prevents feedback loop)
            const rawSession = await redis.get(`session:${sessionId}`);
            if (rawSession) {
                const session = JSON.parse(rawSession);
                if (session.aiSpeaking) {
                    console.log("[ws] AI speaking — ignoring transcript:", transcript);
                    return;
                }
                // Update lastTranscript
                session.lastTranscript = transcript;
                await redis.set(`session:${sessionId}`, JSON.stringify(session));
            }

            console.log("[transcript]", transcript);

            // Mark AI as speaking before TTS starts
            await setAiSpeaking(true);

            try {
                await generateResponse(
                    sessionId,
                    transcript,
                    githubData,
                    // onChunk — send text chunks to frontend for display
                    (chunk) => {
                        if (clientSocket.readyState === WebSocket.OPEN) {
                            clientSocket.send(JSON.stringify({ type: "ai_chunk", chunk }));
                        }
                    },
                    // onSentence — synthesize and stream audio to frontend
                    async (sentence) => {
                        try {
                            console.log("[tts] synthesizing:", sentence);
                            const audioBuffer = await synthesizeSentence(sentence);

                            if (clientSocket.readyState !== WebSocket.OPEN) return;

                            // Tell frontend audio is coming
                            clientSocket.send(JSON.stringify({ type: "tts_start" }));
                            // Send raw binary audio frame
                            clientSocket.send(audioBuffer);
                            // Tell frontend this sentence audio is done
                            clientSocket.send(JSON.stringify({ type: "tts_end" }));
                        } catch (err) {
                            console.error("[tts] synthesis error:", err);
                        }
                    }
                );
            } finally {
                // Always unblock mic input after AI finishes
                await setAiSpeaking(false);
            }

            // Echo user transcript back to frontend
            if (clientSocket.readyState === WebSocket.OPEN) {
                clientSocket.send(JSON.stringify({ type: "transcript", transcript }));
            }
        });

        dgSocket.on("close", (code, reason) => {
            console.log("[deepgram] closed", code, reason.toString());
            clientSocket.close();
        });

        dgSocket.on("error", (err) => console.error("[deepgram] error", err));

        // On disconnect — flush Redis history to Postgres
        clientSocket.on("close", async () => {
            console.log("[frontend] disconnected — flushing Redis history to DB");

            try {
                const rawHistory = await redis.lRange(`history:${sessionId}`, 0, -1);

                if (rawHistory.length > 0) {
                    const messages = rawHistory.map((msg) => {
                        const parsed = JSON.parse(msg);
                        return {
                            interviewId,
                            type: parsed.role === "user" ? "User" as const : "Assistant" as const,
                            message: parsed.content as string,
                        };
                    });

                    await prisma.message.createMany({ data: messages });
                    console.log(`[flush] saved ${messages.length} messages to Postgres`);
                } else {
                    console.log("[flush] no messages to save");
                }
            } catch (err) {
                console.error("[flush] failed to write messages to DB:", err);
            } finally {
                await redis.del(`session:${sessionId}`);
                await redis.del(`history:${sessionId}`);
                console.log("[redis] cleaned up session and history keys");
            }

            if (dgSocket.readyState === WebSocket.OPEN || dgSocket.readyState === WebSocket.CONNECTING) {
                dgSocket.close();
            }
        });
    });
}

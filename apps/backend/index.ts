import express from "express";
import { PreInterviewBody } from "./types";
import { scrapeGithub } from "./scrapers/github";
import cors from "cors";
import { prisma } from "./db";
import { calculateResult } from "./result";
import { setupWebSocket } from "./ws";
import  http from "http"
const app = express();
app.use(express.json());
app.use(cors());

// In-memory lock to prevent concurrent result calculations for the same interview
const calculatingResult = new Set<string>();

app.post("/api/v1/pre-interview", async (req, res) => {
    const { success, data } = PreInterviewBody.safeParse(req.body);

    if (!success) {
        res.status(411).json({ message: "Incorrect body" });
        return;
    }

    const githubUrl = data.github.endsWith("/") ? data.github.slice(0, -1) : data.github;
    const githubUsername = githubUrl.split("/").pop();
    
    console.log(githubUrl,githubUsername)
    if (!githubUsername || githubUsername.length === 0) {
        res.status(400).json({ message: "Invalid GitHub URL" });
        return;
    }

    let githubData = [];
    try {
        githubData = await scrapeGithub(githubUsername);
    } catch (e) {
        console.error("[pre-interview] GitHub scrape failed:", e);
        res.status(400).json({ message: "Could not fetch GitHub profile. Check the URL and try again." });
        return;
    }

    // Store as Json object directly — Prisma Json field does NOT need JSON.stringify
    const interview = await prisma.interview.create({
        data: {
            githubMetadata: githubData,
            status: "Pre"
        }
    });

    res.json({ id: interview.id });
});

// Called by frontend when voice session begins — marks interview as InProgress
app.post("/api/v1/session/start/:interviewId", async (req, res) => {
    const { interviewId } = req.params;

    const interview = await prisma.interview.findFirst({ where: { id: interviewId } });
    if (!interview) {
        res.status(404).json({ message: "Interview not found" });
        return;
    }

    await prisma.interview.update({
        where: { id: interviewId },
        data: { status: "InProgress" }
    });

    res.json({ message: "Interview started" });
});

// Called by Deepgram STT to persist user speech
app.post("/api/v1/session/user/response/:interviewId", async (req, res) => {
    const { message } = req.body;

    if (!message?.trim()) {
        res.status(400).json({ message: "Empty message" });
        return;
    }

    await prisma.message.create({
        data: {
            interviewId: req.params.interviewId,
            type: "User",
            message: message.trim()
        }
    });

    res.json({ message: "Message saved" });
});

// Called by the AI interviewer to persist its own responses
app.post("/api/v1/session/assistant/response/:interviewId", async (req, res) => {
    const { message } = req.body;

    if (!message?.trim()) {
        res.status(400).json({ message: "Empty message" });
        return;
    }

    await prisma.message.create({
        data: {
            interviewId: req.params.interviewId,
            type: "Assistant",
            message: message.trim()
        }
    });

    res.json({ message: "Message saved" });
});

app.get("/api/v1/result/:interviewId", async (req, res) => {
    const { interviewId } = req.params;

    const interview = await prisma.interview.findFirst({
        where: { id: interviewId },
        include: { conversations: true }
    });

    if (!interview) {
        res.status(404).json({ message: "Interview not found" });
        return;
    }

    res.json({
        score: interview.score,
        feedback: interview.feedback,
        transcript: interview.conversations.map(c => ({
            type: c.type,
            content: c.message,
            createdAt: c.createdAt
        })),
        status: interview.status
    });

    if (interview.status !== "Done" && !calculatingResult.has(interviewId)) {
        calculatingResult.add(interviewId);

        calculateResult(interview.conversations)
            .then(result =>
                prisma.interview.update({
                    where: { id: interviewId },
                    data: { status: "Done", feedback: result.feedback, score: result.score }
                })
            )
            .catch(e => console.error("[result] calculation failed:", e))
            .finally(() => calculatingResult.delete(interviewId));
    }
});


// // Issues short-lived Deepgram token so the prod key is never exposed to the browser
// app.get("/api/v1/deepgram/token", async (req, res) => {
//     try {
        
//         const response = await fetch("https://api.deepgram.com/v1/auth/grant", {
//             method: "POST",
//             headers: {
//                 Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
//                 "Content-Type": "application/json",
//             },
//             body: JSON.stringify({
//                 time_to_live: 60,  // token valid for 60s — enough to open the WS
//                 comment: "interview-stt",
//             }),
//         });
//         const data = await response.json() as any;
//         const token=data.access_token;
//         res.json({  token });
//     } catch (e) {
//         console.error("[deepgram/token] failed:", e);
//         res.status(500).json({ message: "Failed to issue Deepgram token" });
//     }
// })?????
const server = http.createServer(app);
setupWebSocket(server);
server.listen(3001, () => console.log("[backend] listening on port 3001"));

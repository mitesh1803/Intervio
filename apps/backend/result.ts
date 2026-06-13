import { z } from "zod";
import Groq from "groq-sdk";
import { RESULT_PROMPT } from "./prompt";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const outputSchema = z.object({
    feedback: z.string().describe("Feedback for the user"),
    score: z.number().int().min(0).max(10).describe("Score out of 10 for their interview"),
});

export async function calculateResult(messages: {type: "Assistant" | "User", message: string, createdAt: Date}[]) {
    const formattedTranscript = messages
        .map(m => `[${m.type}]: ${m.message}`)
        .join("\n");

    const response = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
            {
                role: "user",
                content: RESULT_PROMPT.replace("{{USER_TRANSCRIPT}}", formattedTranscript)
            }
        ],
        response_format: { type: "json_object" },  // forces JSON output
        temperature: 0.3,
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    console.log("[result] raw response:", raw);

    const result = outputSchema.parse(JSON.parse(raw));
    return result;
}
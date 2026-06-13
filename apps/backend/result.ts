import { z } from "zod";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({apiKey: process.env.GEMINI_API_KEY!});

const outputSchema = z.object({
    feedback: z.string().describe("Feedback for the user"),
    score: z.number().int().min(0).max(10).describe("Score out of 10 for their interview"),
});

const RESULT_PROMPT = `
    You are an expert evaluator. Your job is to evaluate the users interview performance.
    Analyze the full conversation transcript below and give the candidate:
    - A score out of 10 (integer only)
    - Detailed, constructive feedback covering their strengths and areas to improve

    Return ONLY a valid JSON object in this exact format, no other text:
    {
        "feedback": "your detailed feedback here",
        "score": 7
    }

    TRANSCRIPT:
    {{USER_TRANSCRIPT}}
`

export async function calculateResult(messages: {type: "Assistant" | "User", message: string, createdAt: Date}[]) {
    const formattedTranscript = messages
        .map(m => `[${m.type}]: ${m.message}`)
        .join("\n");

    const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: RESULT_PROMPT.replace(`{{USER_TRANSCRIPT}}`, formattedTranscript),
        config: {
            responseMimeType: "application/json",
        },
    });

    console.log("[result] raw response:", response.text!);

    const clean = response.text!.replace(/```json|```/g, "").trim();
    const result = outputSchema.parse(JSON.parse(clean));
    return result;
}
import Groq from "groq-sdk";
import { redis } from "./src/lib/redis";
import { systemPrompt } from "./prompt";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Require whitespace after punctuation to avoid splitting on "3.5" or "e.g."
const SENTENCE_END = /[.?!]\s/;

export async function generateResponse(
  sessionId: string,
  transcript: string,
  githubData: string,
  onChunk: (chunk: string) => void,
  onSentence: (sentence: string) => Promise<void>,
) {
  // Push user message to Redis history
  await redis.rPush(
    `history:${sessionId}`,
    JSON.stringify({ role: "user", content: transcript }),
  );

  // Fetch last 10 messages for context window
  const history = await redis.lRange(`history:${sessionId}`, -10, -1);
  const messages = history
    .map((msg) => JSON.parse(msg))
    .filter(
      (msg) =>
        msg.role &&
        ["system", "user", "assistant"].includes(msg.role) &&
        typeof msg.content === "string",
    );

  const Prompt = systemPrompt(githubData)

  // Streaming LLM completion
  const stream = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    stream: true,
    max_tokens: 500,
    messages: [
      {
        role: "system",
        content: Prompt,
      },
      ...messages,
    ],
  });

  let fullResponse = "";
  let sentenceBuffer = "";

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || "";
    if (!content) continue;

    fullResponse += content;
    sentenceBuffer += content;
    onChunk(content);

    // Fire TTS when we hit a sentence boundary
    if (SENTENCE_END.test(sentenceBuffer)) {
      const sentence = sentenceBuffer.trim();
      sentenceBuffer = "";
      if (sentence.length > 0) {
        await onSentence(sentence);
      }
    }
  }

  // Flush any remaining text after stream ends (e.g. no trailing punctuation)
  const remaining = sentenceBuffer.trim();
  if (remaining.length > 0) {
    await onSentence(remaining);
  }

  // Push full AI response to Redis history
  await redis.rPush(
    `history:${sessionId}`,
    JSON.stringify({ role: "assistant", content: fullResponse }),
  );

  return fullResponse;
}
